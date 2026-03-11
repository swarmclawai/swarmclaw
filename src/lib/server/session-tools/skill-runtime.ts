import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import type { Agent, Session, SessionSkillRuntimeState } from '@/types'
import { errorMessage } from '@/lib/shared-utils'
import { loadAgent, loadSkills, patchSession } from '@/lib/server/storage'
import {
  findResolvedSkill,
  recommendRuntimeSkillsForTask,
  resolveRuntimeSkills,
  type ResolvedRuntimeSkill,
  type RuntimeSkillRecommendation,
  type RuntimeSkillSnapshot,
} from '@/lib/server/skills/runtime-skill-resolver'
import type { ToolBuildContext } from './context'
import { normalizeToolInputArgs } from './normalize-tool-args'

function resolveActiveAgent(bctx: ToolBuildContext): Agent | null {
  const agentId = bctx.ctx?.agentId
  if (!agentId) return null
  return loadAgent(agentId) as Agent | null
}

function resolveCurrentSession(bctx: ToolBuildContext): Session | null {
  const session = bctx.resolveCurrentSession?.()
  if (!session || typeof session !== 'object') return null
  return session as Session
}

function selectedSkillIdFromSession(session: Session | null): string | null {
  const selectedSkillId = typeof session?.skillRuntimeState?.selectedSkillId === 'string'
    ? session.skillRuntimeState.selectedSkillId.trim()
    : ''
  return selectedSkillId || null
}

function buildRuntimeSnapshot(bctx: ToolBuildContext): RuntimeSkillSnapshot {
  const session = resolveCurrentSession(bctx)
  const activeAgent = resolveActiveAgent(bctx)
  return resolveRuntimeSkills({
    cwd: bctx.cwd,
    enabledPlugins: bctx.activePlugins,
    agentSkillIds: activeAgent?.skillIds || [],
    storedSkills: loadSkills(),
    selectedSkillId: selectedSkillIdFromSession(session),
  })
}

function summarizeRuntimeSkill(skill: ResolvedRuntimeSkill): Record<string, unknown> {
  return {
    id: skill.id,
    storageId: skill.storageId || null,
    key: skill.key,
    name: skill.name,
    description: skill.description || '',
    status: skill.status,
    source: skill.source,
    attached: skill.attached,
    selected: skill.selected,
    eligible: skill.eligible,
    missing: skill.missing,
    toolNames: skill.toolNames,
    capabilities: skill.capabilities,
    executionMode: skill.executionMode,
    runnable: skill.runnable,
    invocation: skill.invocation || null,
    commandDispatch: skill.commandDispatch || null,
    dispatchBlocker: skill.dispatchBlocker || null,
    sourcePath: skill.sourcePath || null,
    sourceUrl: skill.sourceUrl || null,
  }
}

function parseSearchLimit(raw: unknown, fallback = 8): number {
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(String(raw || ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(20, Math.trunc(parsed)))
}

function resolveSkillSelector(rawArgs: Record<string, unknown>): string {
  for (const key of ['id', 'skillId', 'name']) {
    const value = rawArgs[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function resolveTargetSkill(params: {
  rawArgs: Record<string, unknown>
  snapshot: RuntimeSkillSnapshot
  requireExplicit?: boolean
}): ResolvedRuntimeSkill | null {
  const selector = resolveSkillSelector(params.rawArgs)
  if (selector) return findResolvedSkill(params.snapshot.skills, selector)

  const query = typeof params.rawArgs.query === 'string' ? params.rawArgs.query.trim() : ''
  if (query) {
    const ranked = recommendRuntimeSkillsForTask(params.snapshot.skills, query)
    const top = ranked.find((entry) => entry.skill.eligible || entry.skill.runnable)
      || ranked[0]
    return top?.skill || null
  }

  if (!params.requireExplicit && params.snapshot.selectedSkill) return params.snapshot.selectedSkill
  return null
}

function persistSkillRuntimeState(params: {
  bctx: ToolBuildContext
  skill: ResolvedRuntimeSkill
  action: NonNullable<SessionSkillRuntimeState['lastAction']>
  toolName?: string | null
}): void {
  if (!params.bctx.ctx?.sessionId) return
  patchSession(params.bctx.ctx.sessionId, (currentSession) => {
    if (!currentSession) return currentSession
    const current = currentSession.skillRuntimeState && typeof currentSession.skillRuntimeState === 'object'
      ? currentSession.skillRuntimeState
      : {}
    currentSession.skillRuntimeState = {
      ...current,
      selectedSkillId: params.skill.id,
      selectedSkillName: params.skill.name,
      selectedAt: current.selectedSkillId === params.skill.id ? current.selectedAt || Date.now() : Date.now(),
      lastAction: params.action,
      lastRunAt: params.action === 'run' ? Date.now() : current.lastRunAt || null,
      lastRunToolName: params.action === 'run' ? params.toolName || null : current.lastRunToolName || null,
    }
    currentSession.updatedAt = Date.now()
    return currentSession
  })
}

function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  const parsed = parseJsonValue(value)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  return null
}

function normalizeDispatchArgs(rawArgs: Record<string, unknown>): Record<string, unknown> {
  const reserved = new Set([
    'action',
    'id',
    'skillId',
    'name',
    'query',
    'args',
    'payload',
    'parameters',
    'toolArgs',
    'input',
    'limit',
  ])

  for (const key of ['toolArgs', 'args', 'parameters', 'payload']) {
    const value = rawArgs[key]
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
    if (typeof value === 'string' && value.trim()) {
      const parsed = parseJsonObject(value)
      if (parsed) return parsed
      return { input: value.trim() }
    }
  }

  const directFields = Object.fromEntries(
    Object.entries(rawArgs).filter(([key, value]) => !reserved.has(key) && value !== undefined),
  )
  if (Object.keys(directFields).length > 0) return directFields

  if (typeof rawArgs.input === 'string' && rawArgs.input.trim()) {
    const parsed = parseJsonObject(rawArgs.input)
    if (parsed) return parsed
    return { input: rawArgs.input.trim() }
  }

  return {}
}

function explainSkillBlocker(skill: ResolvedRuntimeSkill | null): Record<string, unknown> {
  if (!skill) {
    return {
      ok: false,
      blocker: 'No selected skill is available for this run.',
    }
  }

  if (skill.executionMode === 'prompt') {
    return {
      ok: false,
      skill: summarizeRuntimeSkill(skill),
      blocker: 'This skill does not expose executable dispatch metadata.',
      nextAction: 'Call use_skill with action="load" once, then follow the loaded guidance.',
    }
  }

  if (!skill.runnable) {
    return {
      ok: false,
      skill: summarizeRuntimeSkill(skill),
      blocker: skill.dispatchBlocker || 'The selected skill is not runnable in the current session.',
      missing: skill.missing,
    }
  }

  return {
    ok: true,
    skill: summarizeRuntimeSkill(skill),
    blocker: null,
  }
}

async function dispatchSkillRun(params: {
  bctx: ToolBuildContext
  skill: ResolvedRuntimeSkill
  rawArgs: Record<string, unknown>
}): Promise<string> {
  const dispatch = params.skill.commandDispatch
  if (!dispatch || dispatch.kind !== 'tool') {
    return JSON.stringify({
      ok: true,
      executed: false,
      mode: 'prompt_guidance',
      skill: summarizeRuntimeSkill(params.skill),
      guidance: params.skill.content,
      message: 'This skill has no executable dispatch surface. Follow the loaded guidance in the next step.',
    })
  }

  if (!params.skill.runnable) {
    return JSON.stringify({
      ok: false,
      executed: false,
      mode: 'dispatch_blocked',
      skill: summarizeRuntimeSkill(params.skill),
      blocker: params.skill.dispatchBlocker || 'The selected skill is not runnable in this session.',
      missing: params.skill.missing,
    })
  }

  if (dispatch.toolName === 'use_skill') {
    return JSON.stringify({
      ok: false,
      executed: false,
      mode: 'dispatch_blocked',
      skill: summarizeRuntimeSkill(params.skill),
      blocker: 'A skill cannot dispatch back into use_skill.',
    })
  }

  const toolArgs = normalizeDispatchArgs(params.rawArgs)
  const { buildSessionTools } = await import('./index')
  const built = await buildSessionTools(params.bctx.cwd, params.bctx.activePlugins, params.bctx.ctx)
  try {
    const targetTool = built.tools.find((entry) => entry.name === dispatch.toolName)
    if (!targetTool) {
      return JSON.stringify({
        ok: false,
        executed: false,
        mode: 'dispatch_blocked',
        skill: summarizeRuntimeSkill(params.skill),
        blocker: `Dispatch tool "${dispatch.toolName}" is not available in this session.`,
      })
    }

    const toolOutput = await targetTool.invoke(toolArgs)
    persistSkillRuntimeState({
      bctx: params.bctx,
      skill: params.skill,
      action: 'run',
      toolName: dispatch.toolName,
    })

    return JSON.stringify({
      ok: true,
      executed: true,
      mode: 'dispatch',
      skill: summarizeRuntimeSkill(params.skill),
      dispatchedTool: dispatch.toolName,
      toolArgs,
      toolOutput: typeof toolOutput === 'string'
        ? (parseJsonValue(toolOutput) ?? toolOutput)
        : toolOutput,
    })
  } finally {
    await built.cleanup()
  }
}

export function buildSkillRuntimeTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  return [
    tool(
      async (rawArgs) => {
        const normalized = normalizeToolInputArgs((rawArgs ?? {}) as Record<string, unknown>)
        const action = typeof normalized.action === 'string' ? normalized.action.trim().toLowerCase() : ''
        const snapshot = buildRuntimeSnapshot(bctx)

        try {
          switch (action) {
            case 'list': {
              const query = typeof normalized.query === 'string' ? normalized.query.trim() : ''
              const limit = parseSearchLimit(normalized.limit, 12)
              const ranked: RuntimeSkillRecommendation[] = query
                ? recommendRuntimeSkillsForTask(snapshot.skills, query, bctx.activePlugins)
                : snapshot.skills.map((skill) => ({ skill, score: skill.score, reasons: skill.matchReasons }))
              return JSON.stringify({
                selectedSkillId: snapshot.selectedSkill?.id || null,
                skills: ranked.slice(0, limit).map((entry) => ({
                  ...summarizeRuntimeSkill(entry.skill),
                  score: entry.score,
                  reasons: entry.reasons,
                })),
              })
            }
            case 'select': {
              const target = resolveTargetSkill({ rawArgs: normalized, snapshot, requireExplicit: true })
              if (!target) return JSON.stringify({ ok: false, blocker: 'No matching skill found to select.' })
              persistSkillRuntimeState({ bctx, skill: target, action: 'select' })
              return JSON.stringify({
                ok: true,
                selected: true,
                skill: summarizeRuntimeSkill(target),
              })
            }
            case 'load': {
              const target = resolveTargetSkill({ rawArgs: normalized, snapshot })
              if (!target) return JSON.stringify({ ok: false, blocker: 'No selected or matching skill found to load.' })
              persistSkillRuntimeState({ bctx, skill: target, action: 'load' })
              return JSON.stringify({
                ok: true,
                loaded: true,
                skill: summarizeRuntimeSkill(target),
                guidance: target.content,
              })
            }
            case 'run': {
              const target = resolveTargetSkill({ rawArgs: normalized, snapshot })
              if (!target) return JSON.stringify({ ok: false, blocker: 'No selected or matching skill found to run.' })
              persistSkillRuntimeState({ bctx, skill: target, action: 'select' })
              return dispatchSkillRun({ bctx, skill: target, rawArgs: normalized })
            }
            case 'explain_blocker': {
              const target = resolveTargetSkill({ rawArgs: normalized, snapshot })
              return JSON.stringify(explainSkillBlocker(target))
            }
            default:
              return `Error: Unknown action "${action}".`
          }
        } catch (err: unknown) {
          return `Error: ${errorMessage(err)}`
        }
      },
      {
        name: 'use_skill',
        description: [
          'Runtime skill selection and execution surface.',
          'Use `list` to inspect available skills, `select` to persist one for the current task, `load` to fetch its guidance, `run` to dispatch executable skills through their bound tools, and `explain_blocker` to understand why a selected skill cannot run.',
          'Prefer this tool over stuffing many skill bodies into the prompt.',
        ].join('\n\n'),
        schema: z.object({
          action: z.enum(['list', 'select', 'load', 'run', 'explain_blocker']),
          id: z.string().optional().describe('Skill runtime id or stored skill id'),
          skillId: z.string().optional().describe('Alternate skill selector'),
          name: z.string().optional().describe('Skill name selector'),
          query: z.string().optional().describe('Task query used to rank/select a skill'),
          limit: z.number().optional().describe('Maximum number of listed skills'),
          input: z.string().optional().describe('String input forwarded to the dispatched tool when the skill uses raw dispatch'),
          args: z.union([z.string(), z.record(z.string(), z.unknown())]).optional().describe('Tool arguments for action="run"'),
          parameters: z.union([z.string(), z.record(z.string(), z.unknown())]).optional().describe('Alternate tool arguments for action="run"'),
          payload: z.union([z.string(), z.record(z.string(), z.unknown())]).optional().describe('Alternate tool arguments for action="run"'),
          toolArgs: z.record(z.string(), z.unknown()).optional().describe('Object args forwarded directly to the dispatched tool'),
        }).passthrough(),
      },
    ),
  ]
}
