import { genId } from '@/lib/id'
import type { ApprovalRequest, Agent, Skill } from '@/types'
import { dedup, errorMessage } from '@/lib/shared-utils'
import { requestApproval } from '@/lib/server/approvals'
import {
  loadAgent,
  loadApprovals,
  loadSkills,
  patchAgent,
  saveSkills,
} from '@/lib/server/storage'
import { fetchSkillContent, searchClawHub } from '@/lib/server/skills/clawhub-client'
import { clearDiscoveredSkillsCache } from '@/lib/server/skills/skill-discovery'
import {
  buildRuntimeSkillPromptBlocks,
  findResolvedSkill,
  recommendRuntimeSkillsForTask,
  resolveRuntimeSkills,
  type ResolvedRuntimeSkill,
} from '@/lib/server/skills/runtime-skill-resolver'
import { normalizeSkillPayload } from '@/lib/server/skills/skills-normalize'
import type { ToolBuildContext } from './context'

type SkillSelectorInput = {
  id?: string
  skillId?: string
  name?: string
  url?: string
  content?: string
}

function normalizeKey(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    : ''
}

function buildCrudPayload(
  normalized: Record<string, unknown>,
  action: string | undefined,
  data: string | undefined,
): Record<string, unknown> {
  if (data) return JSON.parse(data)
  if (action !== 'create' && action !== 'update') return {}
  const entries = Object.entries(normalized).filter(([key]) =>
    ![
      'action',
      'id',
      'skillId',
      'data',
      'query',
      'task',
      'url',
      'approvalId',
      'attach',
      'agentId',
      'targetAgentId',
      'input',
      'args',
      'arguments',
      'payload',
      'parameters',
    ].includes(key),
  )
  return entries.length > 0 ? Object.fromEntries(entries) : {}
}

function summarizeSkill(skill: ResolvedRuntimeSkill): Record<string, unknown> {
  return {
    id: skill.id,
    storageId: skill.storageId || null,
    key: skill.key,
    name: skill.name,
    description: skill.description || '',
    source: skill.source,
    managed: skill.managed,
    attached: skill.attached,
    eligible: skill.eligible,
    status: skill.status,
    missing: skill.missing,
    toolNames: skill.toolNames,
    capabilities: skill.capabilities,
    installOptions: skill.installOptions || [],
    autoMatch: skill.autoMatch,
    matchReasons: skill.matchReasons,
    invocation: skill.invocation || null,
    commandDispatch: skill.commandDispatch || null,
    executionMode: skill.executionMode,
    runnable: skill.runnable,
    selected: skill.selected,
    dispatchBlocker: skill.dispatchBlocker || null,
    sourcePath: skill.sourcePath || null,
    sourceUrl: skill.sourceUrl || null,
  }
}

function resolveActiveAgent(bctx: ToolBuildContext): Agent | null {
  const agentId = bctx.ctx?.agentId
  if (!agentId) return null
  return loadAgent(agentId) as Agent | null
}

function resolveTargetAgentId(
  payload: Record<string, unknown>,
  bctx: ToolBuildContext,
): string | null {
  const requested = typeof payload.agentId === 'string' && payload.agentId.trim()
    ? payload.agentId.trim()
    : typeof payload.targetAgentId === 'string' && payload.targetAgentId.trim()
      ? payload.targetAgentId.trim()
      : bctx.ctx?.agentId || null

  if (!requested) return null
  if (bctx.ctx?.platformAssignScope !== 'all' && requested !== bctx.ctx?.agentId) {
    throw new Error(`You may only attach skills to your own agent (${bctx.ctx?.agentId || 'current agent'}) in this session.`)
  }
  const target = loadAgent(requested)
  if (!target) throw new Error(`Agent "${requested}" not found.`)
  return requested
}

function upsertStoredSkill(input: {
  existingId?: string
  body: Record<string, unknown>
}): Skill {
  const skills = loadSkills()
  const normalized = normalizeSkillPayload(input.body)
  const now = Date.now()
  const id = input.existingId || genId()
  const previous = input.existingId ? skills[input.existingId] : null

  const next: Skill = {
    id,
    name: normalized.name,
    filename: normalized.filename || previous?.filename || `skill-${id}.md`,
    content: normalized.content || '',
    description: normalized.description || '',
    sourceUrl: normalized.sourceUrl,
    sourceFormat: normalized.sourceFormat,
    author: normalized.author,
    tags: normalized.tags,
    version: normalized.version,
    homepage: normalized.homepage,
    primaryEnv: normalized.primaryEnv,
    skillKey: normalized.skillKey,
    toolNames: normalized.toolNames,
    capabilities: normalized.capabilities,
    always: normalized.always,
    installOptions: normalized.installOptions,
    skillRequirements: normalized.skillRequirements,
    detectedEnvVars: normalized.detectedEnvVars,
    security: normalized.security,
    invocation: normalized.invocation,
    commandDispatch: normalized.commandDispatch,
    frontmatter: normalized.frontmatter,
    scope: input.body.scope === 'agent' ? 'agent' : previous?.scope || 'global',
    agentIds: Array.isArray(input.body.agentIds)
      ? (input.body.agentIds as unknown[]).filter((value): value is string => typeof value === 'string')
      : previous?.agentIds,
    createdAt: previous?.createdAt || now,
    updatedAt: now,
  }

  skills[id] = next
  saveSkills(skills)
  clearDiscoveredSkillsCache()
  return next
}

function attachSkillToAgent(skillId: string, agentId: string): Agent {
  const updated = patchAgent(agentId, (current) => {
    if (!current) return current
    const nextSkillIds = dedup([...(Array.isArray(current.skillIds) ? current.skillIds : []), skillId])
    current.skillIds = nextSkillIds
    current.updatedAt = Date.now()
    return current
  })
  if (!updated) throw new Error(`Agent "${agentId}" not found.`)
  return updated as Agent
}

function findStoredSkillBySelector(skills: Record<string, Skill>, selector: SkillSelectorInput): Skill | null {
  const directId = selector.id || selector.skillId
  if (directId && skills[directId]) return skills[directId]

  const normalizedName = normalizeKey(selector.name)
  if (!normalizedName) return null
  return Object.values(skills).find((skill) =>
    normalizeKey(skill.id) === normalizedName
    || normalizeKey(skill.name) === normalizedName
    || normalizeKey(skill.skillKey || '') === normalizedName,
  ) || null
}

function buildSkillSnapshot(bctx: ToolBuildContext) {
  clearDiscoveredSkillsCache()
  const activeAgent = resolveActiveAgent(bctx)
  const session = bctx.resolveCurrentSession?.()
  return resolveRuntimeSkills({
    cwd: bctx.cwd,
    enabledPlugins: bctx.activePlugins,
    agentSkillIds: activeAgent?.skillIds || [],
    storedSkills: loadSkills(),
    selectedSkillId: typeof session?.skillRuntimeState?.selectedSkillId === 'string'
      ? session.skillRuntimeState.selectedSkillId
      : null,
  })
}

function findPendingInstallApproval(params: {
  sessionId?: string | null
  agentId?: string | null
  question: string
  prompt: string
}): ApprovalRequest | null {
  return Object.values(loadApprovals()).find((approval) =>
    approval.status === 'pending'
    && approval.category === 'human_loop'
    && (approval.sessionId || null) === (params.sessionId || null)
    && (approval.agentId || null) === (params.agentId || null)
    && approval.data?.question === params.question
    && approval.data?.prompt === params.prompt,
  ) || null
}

function ensureApprovedInstall(approvalId: string | null | undefined): ApprovalRequest {
  const normalized = typeof approvalId === 'string' ? approvalId.trim() : ''
  if (!normalized) {
    throw new Error('This install requires approval. Call manage_skills install first to create the approval request, then retry with approvalId after approval.')
  }
  const approval = loadApprovals()[normalized]
  if (!approval) throw new Error(`Approval "${normalized}" not found.`)
  if (approval.status !== 'approved') {
    throw new Error(`Approval "${normalized}" is not approved yet.`)
  }
  return approval
}

async function materializeResolvedSkill(skill: ResolvedRuntimeSkill): Promise<Skill> {
  const skills = loadSkills()
  const existing = skill.storageId ? skills[skill.storageId] : null
  if (existing) return existing
  const duplicate = Object.values(skills).find((entry) =>
    normalizeKey(entry.skillKey || entry.name) === normalizeKey(skill.skillKey || skill.name),
  )
  if (duplicate) return duplicate
  return upsertStoredSkill({
    body: {
      name: skill.name,
      filename: skill.filename,
      description: skill.description,
      content: skill.content,
      sourceUrl: skill.sourceUrl,
      sourceFormat: skill.sourceFormat,
      author: skill.author,
      tags: skill.tags,
      version: skill.version,
      homepage: skill.homepage,
      primaryEnv: skill.primaryEnv,
      skillKey: skill.skillKey,
      toolNames: skill.toolNames,
      capabilities: skill.capabilities,
      always: skill.always,
      installOptions: skill.installOptions,
      skillRequirements: skill.skillRequirements,
      detectedEnvVars: skill.detectedEnvVars,
      security: skill.security,
      invocation: skill.invocation,
      commandDispatch: skill.commandDispatch,
      frontmatter: skill.frontmatter,
    },
  })
}

async function installRemoteSkill(params: {
  name?: string
  description?: string
  url: string
  author?: string
  tags?: string[]
  content?: string
}): Promise<Skill> {
  const content = params.content || await fetchSkillContent(params.url)
  const skills = loadSkills()
  const normalizedBody = normalizeSkillPayload({
    name: params.name,
    description: params.description,
    sourceUrl: params.url,
    author: params.author,
    tags: params.tags,
    content,
  })

  const duplicate = Object.values(skills).find((skill) =>
    normalizeKey(skill.skillKey || skill.name) === normalizeKey(normalizedBody.skillKey || normalizedBody.name),
  )
  if (duplicate) return duplicate

  return upsertStoredSkill({
    body: {
      ...normalizedBody,
      content,
    },
  })
}

function parseSearchLimit(raw: unknown, fallback = 8): number {
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(String(raw || ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(20, Math.trunc(parsed)))
}

export function buildManageSkillsDescription(): string {
  return [
    'Manage reusable skills and runtime skill discovery.',
    'Supported actions: `list`, `get`, `create`, `update`, `delete`, `status`, `search_available`, `recommend_for_task`, `attach`, `install`.',
    'Use `status` to inspect local/runtime skills with eligibility and missing requirements.',
    'Use `recommend_for_task` when a task may benefit from a reusable workflow.',
    'Use `use_skill` for runtime selection, loading, and execution of an already-discovered skill.',
    'Use `install` only when you intentionally want to add a skill. Installation is explicit and approval-gated.',
    'Use this direct tool name exactly as shown (`manage_skills`).',
  ].join('\n\n')
}

export async function executeManageSkillsAction(
  rawArgs: Record<string, unknown>,
  bctx: ToolBuildContext,
): Promise<string> {
  const normalized = rawArgs
  const action = typeof normalized.action === 'string' ? normalized.action.trim().toLowerCase() : ''
  const data = typeof normalized.data === 'string' ? normalized.data : undefined
  const payload = buildCrudPayload(normalized, action, data)

  try {
    switch (action) {
      case 'list': {
        return JSON.stringify(Object.values(loadSkills()))
      }
      case 'get': {
        const skills = loadSkills()
        const selected = findStoredSkillBySelector(skills, {
          id: typeof normalized.id === 'string' ? normalized.id : undefined,
          skillId: typeof normalized.skillId === 'string' ? normalized.skillId : undefined,
          name: typeof normalized.name === 'string' ? normalized.name : undefined,
        })
        if (!selected) return 'Not found.'
        return JSON.stringify(selected)
      }
      case 'create': {
        const created = upsertStoredSkill({ body: payload })
        return JSON.stringify(created)
      }
      case 'update': {
        const skillId = typeof normalized.id === 'string' ? normalized.id.trim() : ''
        if (!skillId) return 'Error: "id" is required for update action.'
        const existing = loadSkills()[skillId]
        if (!existing) return `Not found: skills "${skillId}"`
        const updated = upsertStoredSkill({
          existingId: skillId,
          body: { ...existing, ...payload },
        })
        return JSON.stringify(updated)
      }
      case 'delete': {
        const skillId = typeof normalized.id === 'string' ? normalized.id.trim() : ''
        if (!skillId) return 'Error: "id" is required for delete action.'
        const skills = loadSkills()
        if (!skills[skillId]) return `Not found: skills "${skillId}"`
        delete skills[skillId]
        saveSkills(skills)
        return JSON.stringify({ deleted: skillId })
      }
      case 'status': {
        const snapshot = buildSkillSnapshot(bctx)
        const query = typeof normalized.query === 'string' ? normalized.query.trim() : ''
        const ranked = query
          ? recommendRuntimeSkillsForTask(snapshot.skills, query, bctx.activePlugins).map((entry) => entry.skill)
          : snapshot.skills
        const limit = parseSearchLimit(normalized.limit, 12)
        return JSON.stringify(ranked.slice(0, limit).map(summarizeSkill))
      }
      case 'search_available': {
        const snapshot = buildSkillSnapshot(bctx)
        const query = typeof normalized.query === 'string' ? normalized.query.trim() : ''
        const limit = parseSearchLimit(normalized.limit, 8)
        const local = query
          ? recommendRuntimeSkillsForTask(snapshot.skills, query, bctx.activePlugins).slice(0, limit)
          : snapshot.skills.slice(0, limit).map((skill) => ({ skill, score: skill.score, reasons: skill.matchReasons }))
        const marketplace = query ? await searchClawHub(query, 1, limit) : { skills: [], total: 0, page: 1 }
        return JSON.stringify({
          local: local.map((entry) => ({
            ...summarizeSkill(entry.skill),
            score: entry.score,
            reasons: entry.reasons,
          })),
          marketplace: marketplace.skills,
        })
      }
      case 'recommend_for_task': {
        const task = typeof normalized.task === 'string' && normalized.task.trim()
          ? normalized.task.trim()
          : typeof normalized.query === 'string' ? normalized.query.trim() : ''
        if (!task) return 'Error: "task" or "query" is required for recommend_for_task.'
        const snapshot = buildSkillSnapshot(bctx)
        const local = recommendRuntimeSkillsForTask(snapshot.skills, task, bctx.activePlugins).slice(0, 8)
        const remote = local.length >= 3 ? { skills: [] } : await searchClawHub(task, 1, 5)
        return JSON.stringify({
          local: local.map((entry) => ({
            ...summarizeSkill(entry.skill),
            score: entry.score,
            reasons: entry.reasons,
            promptEligible: snapshot.promptSkills.some((skill) => skill.id === entry.skill.id),
          })),
          marketplace: remote.skills,
          promptBlocks: buildRuntimeSkillPromptBlocks({
            ...snapshot,
            promptSkills: local.map((entry) => entry.skill).filter((skill) => skill.eligible),
            availableSkills: snapshot.skills.filter((skill) => !local.some((entry) => entry.skill.id === skill.id)),
          }),
        })
      }
      case 'attach': {
        const snapshot = buildSkillSnapshot(bctx)
        const target = findResolvedSkill(snapshot.skills, String(normalized.id || normalized.skillId || normalized.name || ''))
        if (!target) return 'Error: skill not found in local/runtime skills.'
        const stored = await materializeResolvedSkill(target)
        const agentId = resolveTargetAgentId(normalized, bctx)
        if (!agentId) return 'Error: no target agent available for attach.'
        attachSkillToAgent(stored.id, agentId)
        return JSON.stringify({
          ok: true,
          agentId,
          skillId: stored.id,
          skillName: stored.name,
          attached: true,
        })
      }
      case 'install': {
        const snapshot = buildSkillSnapshot(bctx)
        const selector = String(normalized.id || normalized.skillId || normalized.name || '').trim()
        const localTarget = selector ? findResolvedSkill(snapshot.skills, selector) : null
        const attach = normalized.attach === true
        const attachAgentId = attach ? resolveTargetAgentId(normalized, bctx) : null

        if (localTarget) {
          if (!localTarget.storageId) {
            const question = `Install local skill "${localTarget.name}" into managed skills?`
            const prompt = localTarget.sourcePath || localTarget.id
            const pending = findPendingInstallApproval({
              sessionId: bctx.ctx?.sessionId || null,
              agentId: bctx.ctx?.agentId || null,
              question,
              prompt,
            })
            if (!normalized.approvalId) {
              const approval = pending || requestApproval({
                category: 'human_loop',
                title: `Install skill "${localTarget.name}"`,
                description: 'Approve copying this local skill into managed skills so it can be attached and reused durably.',
                agentId: bctx.ctx?.agentId || null,
                sessionId: bctx.ctx?.sessionId || null,
                data: {
                  question,
                  prompt,
                  action: 'manage_skills.install',
                  skillName: localTarget.name,
                  runtimeSkillId: localTarget.id,
                  attachAgentId,
                },
              })
              return JSON.stringify({
                ok: false,
                requiresApproval: true,
                approval,
                skill: summarizeSkill(localTarget),
              })
            }
            ensureApprovedInstall(typeof normalized.approvalId === 'string' ? normalized.approvalId : null)
          }

          const stored = await materializeResolvedSkill(localTarget)
          if (attach && attachAgentId) attachSkillToAgent(stored.id, attachAgentId)
          return JSON.stringify({
            ok: true,
            installed: true,
            source: localTarget.source,
            deduplicated: Boolean(localTarget.storageId),
            skill: stored,
            attachedToAgentId: attachAgentId,
          })
        }

        const url = typeof normalized.url === 'string' ? normalized.url.trim() : ''
        let remoteTarget = {
          name: typeof normalized.name === 'string' ? normalized.name.trim() : '',
          description: typeof normalized.description === 'string' ? normalized.description.trim() : '',
          url,
          author: typeof normalized.author === 'string' ? normalized.author.trim() : '',
          tags: Array.isArray(normalized.tags)
            ? normalized.tags.filter((value): value is string => typeof value === 'string')
            : [],
          content: typeof normalized.content === 'string' ? normalized.content : undefined,
        }

        if (!remoteTarget.url) {
          const query = remoteTarget.name || (typeof normalized.query === 'string' ? normalized.query.trim() : '')
          if (!query) return 'Error: install requires a local skill selector, `url`, or a `name`/`query` to search.'
          const marketplace = await searchClawHub(query, 1, 5)
          const exact = marketplace.skills.find((skill) =>
            normalizeKey(skill.name) === normalizeKey(query)
            || normalizeKey(skill.id) === normalizeKey(query),
          ) || marketplace.skills[0]
          if (!exact) return `Error: no marketplace skill found for "${query}".`
          remoteTarget = {
            ...remoteTarget,
            name: exact.name,
            description: exact.description,
            url: exact.url,
            author: exact.author,
            tags: exact.tags,
          }
        }

        const question = `Install skill "${remoteTarget.name || remoteTarget.url}" from ${remoteTarget.url}?`
        const prompt = remoteTarget.url
        const pending = findPendingInstallApproval({
          sessionId: bctx.ctx?.sessionId || null,
          agentId: bctx.ctx?.agentId || null,
          question,
          prompt,
        })

        if (!normalized.approvalId) {
          const approval = pending || requestApproval({
            category: 'human_loop',
            title: `Install skill "${remoteTarget.name || 'remote skill'}"`,
            description: 'Approve adding this external skill to managed skills.',
            agentId: bctx.ctx?.agentId || null,
            sessionId: bctx.ctx?.sessionId || null,
            data: {
              question,
              prompt,
              action: 'manage_skills.install',
              skillName: remoteTarget.name,
              url: remoteTarget.url,
              attachAgentId,
            },
          })
          return JSON.stringify({
            ok: false,
            requiresApproval: true,
            approval,
            source: 'clawhub',
            skill: remoteTarget,
          })
        }

        ensureApprovedInstall(typeof normalized.approvalId === 'string' ? normalized.approvalId : null)
        const installed = await installRemoteSkill(remoteTarget)
        if (attach && attachAgentId) attachSkillToAgent(installed.id, attachAgentId)
        return JSON.stringify({
          ok: true,
          installed: true,
          source: 'clawhub',
          skill: installed,
          attachedToAgentId: attachAgentId,
        })
      }
      default:
        return `Error: Unknown action "${action}".`
    }
  } catch (err: unknown) {
    return `Error: ${errorMessage(err)}`
  }
}
