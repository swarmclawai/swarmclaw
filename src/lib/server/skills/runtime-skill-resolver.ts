import type {
  Skill,
  SkillCommandDispatch,
  SkillInstallOption,
  SkillInvocationConfig,
  SkillRequirements,
  SkillSecuritySummary,
} from '@/types'
import { dedup } from '@/lib/shared-utils'
import { expandPluginIds, getPluginAliases, normalizePluginId } from '@/lib/server/tool-aliases'
import { loadSettings, loadSkills } from '@/lib/server/storage'
import { discoverSkills, type DiscoveredSkill } from './skill-discovery'
import { evaluateSkillEligibility } from './skill-eligibility'
import {
  MAX_SKILLS_IN_PROMPT,
  MAX_SKILLS_PROMPT_CHARS,
} from './skill-prompt-budget'

export type RuntimeSkillSource = 'stored' | 'bundled' | 'workspace' | 'project'

type SkillSeed = {
  runtimeId: string
  storageId?: string
  name: string
  key: string
  filename: string
  content: string
  description?: string
  tags: string[]
  toolNames: string[]
  capabilities: string[]
  source: RuntimeSkillSource
  sourcePath?: string
  sourceUrl?: string
  sourceFormat?: Skill['sourceFormat']
  author?: string
  version?: string
  homepage?: string
  primaryEnv?: string | null
  skillKey?: string | null
  always: boolean
  attached: boolean
  installOptions?: SkillInstallOption[]
  skillRequirements?: SkillRequirements
  detectedEnvVars?: string[]
  security?: SkillSecuritySummary | null
  invocation?: SkillInvocationConfig | null
  commandDispatch?: SkillCommandDispatch | null
  frontmatter?: Record<string, unknown> | null
  priority: number
}

export interface RuntimeSkillConfigCheck {
  key: string
  ok: boolean
}

export interface RuntimeSkillStatus {
  eligible: boolean
  missingBins: string[]
  missingAnyBins: string[][]
  missingEnv: string[]
  missingConfig: string[]
  unsupportedOs: boolean
  reasons: string[]
  configChecks: RuntimeSkillConfigCheck[]
  installRequired: boolean
}

export interface ResolvedRuntimeSkill {
  id: string
  key: string
  storageId?: string
  name: string
  filename: string
  content: string
  description?: string
  tags: string[]
  toolNames: string[]
  capabilities: string[]
  source: RuntimeSkillSource
  sourcePath?: string
  sourceUrl?: string
  sourceFormat?: Skill['sourceFormat']
  author?: string
  version?: string
  homepage?: string
  primaryEnv?: string | null
  skillKey?: string | null
  always: boolean
  attached: boolean
  managed: boolean
  installOptions?: SkillInstallOption[]
  skillRequirements?: SkillRequirements
  detectedEnvVars?: string[]
  security?: SkillSecuritySummary | null
  invocation?: SkillInvocationConfig | null
  commandDispatch?: SkillCommandDispatch | null
  frontmatter?: Record<string, unknown> | null
  eligible: boolean
  missing: string[]
  reasons: string[]
  status: 'ready' | 'needs_install' | 'blocked'
  configChecks: RuntimeSkillConfigCheck[]
  autoMatch: boolean
  matchReasons: string[]
  score: number
  selected: boolean
  executionMode: 'dispatch' | 'prompt'
  runnable: boolean
  dispatchToolAvailable: boolean
  dispatchBlocker?: string | null
}

export interface RuntimeSkillSnapshot {
  skills: ResolvedRuntimeSkill[]
  promptSkills: ResolvedRuntimeSkill[]
  availableSkills: ResolvedRuntimeSkill[]
  autoMatchedSkills: ResolvedRuntimeSkill[]
  attachedSkills: ResolvedRuntimeSkill[]
  selectedSkill: ResolvedRuntimeSkill | null
}

export interface ResolveRuntimeSkillsOptions {
  cwd?: string | null
  enabledPlugins?: string[] | null
  agentSkillIds?: string[] | null
  storedSkills?: Record<string, Skill>
  selectedSkillId?: string | null
}

export interface RuntimeSkillRecommendation {
  skill: ResolvedRuntimeSkill
  score: number
  reasons: string[]
}

const SOURCE_PRIORITY: Record<RuntimeSkillSource, number> = {
  bundled: 10,
  stored: 20,
  workspace: 30,
  project: 40,
}

function normalizeKey(value: string | null | undefined): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function tokenize(value: string | null | undefined): string[] {
  return dedup(
    String(value || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .map((part) => part.trim())
      .filter((part) => part.length >= 2),
  )
}

function scoreOverlap(a: string[], b: Set<string>): number {
  let total = 0
  for (const token of a) {
    if (b.has(token)) total += 1
  }
  return total
}

function buildSkillKey(input: {
  skillKey?: string | null
  name: string
  filename?: string | null
}): string {
  return normalizeKey(input.skillKey || input.name || input.filename || 'skill')
}

function inferToolNames(input: {
  name: string
  skillKey?: string | null
  explicit?: string[]
}): string[] {
  const explicit = dedup((input.explicit || []).map((value) => normalizePluginId(value)).filter(Boolean))
  if (explicit.length > 0) return explicit

  const inferred = new Set<string>()
  for (const candidate of [input.skillKey, input.name]) {
    const normalized = normalizeKey(candidate || '')
    if (!normalized) continue
    const aliases = getPluginAliases(normalized)
    if (aliases.length > 1) {
      for (const alias of aliases) inferred.add(normalizePluginId(alias))
      continue
    }
    const dashed = normalized.replace(/_/g, '-')
    const dashedAliases = getPluginAliases(dashed)
    if (dashedAliases.length > 1) {
      for (const alias of dashedAliases) inferred.add(normalizePluginId(alias))
    }
  }
  return [...inferred].filter(Boolean)
}

function inferCapabilities(input: {
  name: string
  description?: string
  tags?: string[]
  toolNames?: string[]
  explicit?: string[]
}): string[] {
  return dedup([
    ...(input.explicit || []),
    ...(input.tags || []),
    ...(input.toolNames || []),
    ...tokenize(input.name),
    ...tokenize(input.description),
  ].map((value) => value.trim()).filter(Boolean))
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function readConfigPath(source: Record<string, unknown>, keyPath: string): unknown {
  const parts = keyPath
    .split('.')
    .map((part) => part.trim())
    .filter(Boolean)
  let current: unknown = source
  for (const part of parts) {
    const record = asPlainRecord(current)
    if (!record || !Object.prototype.hasOwnProperty.call(record, part)) return undefined
    current = record[part]
  }
  return current
}

function isTruthyConfigValue(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0
  return true
}

function evaluateSkillStatus(seed: SkillSeed): RuntimeSkillStatus {
  const baseSkill = {
    id: seed.storageId || seed.runtimeId,
    name: seed.name,
    filename: seed.filename,
    content: seed.content,
    skillRequirements: seed.skillRequirements,
  } satisfies Pick<Skill, 'id' | 'name' | 'filename' | 'content' | 'skillRequirements'>
  const eligibility = evaluateSkillEligibility(baseSkill as Skill)
  const settings = loadSettings() as Record<string, unknown>
  const configKeys = Array.isArray(seed.skillRequirements?.config) ? seed.skillRequirements?.config : []
  const configChecks = configKeys.map((key) => ({
    key,
    ok: isTruthyConfigValue(readConfigPath(settings, key)),
  }))
  const missingConfig = configChecks.filter((check) => !check.ok).map((check) => check.key)
  const reasons = [
    ...eligibility.reasons,
    ...(missingConfig.length > 0 ? [`Missing config: ${missingConfig.join(', ')}`] : []),
  ]
  const installRequired = reasons.length > 0
    && ((seed.installOptions?.length || 0) > 0 || eligibility.missingBins.length > 0 || eligibility.missingAnyBins.length > 0)

  return {
    ...eligibility,
    missingConfig,
    reasons,
    configChecks,
    installRequired,
    eligible: eligibility.eligible && missingConfig.length === 0,
  }
}

function formatMissing(status: RuntimeSkillStatus): string[] {
  const missing: string[] = []
  for (const value of status.missingBins) missing.push(value)
  for (const group of status.missingAnyBins) {
    if (group.length > 0) missing.push(`one of: ${group.join(' | ')}`)
  }
  for (const value of status.missingEnv) missing.push(`env ${value}`)
  for (const value of status.missingConfig) missing.push(`config ${value}`)
  if (status.unsupportedOs) missing.push(`os ${process.platform}`)
  return missing
}

function buildSeedFromStored(skill: Skill, attachedIds: Set<string>): SkillSeed {
  const explicitToolNames = Array.isArray(skill.toolNames) ? skill.toolNames : []
  const toolNames = inferToolNames({
    name: skill.name,
    skillKey: skill.skillKey,
    explicit: explicitToolNames,
  })

  return {
    runtimeId: `runtime:stored:${buildSkillKey(skill)}`,
    storageId: skill.id,
    name: skill.name,
    key: buildSkillKey(skill),
    filename: skill.filename,
    content: skill.content || '',
    description: skill.description || '',
    tags: dedup(Array.isArray(skill.tags) ? skill.tags : []),
    toolNames,
    capabilities: inferCapabilities({
      name: skill.name,
      description: skill.description,
      tags: skill.tags,
      toolNames,
      explicit: Array.isArray(skill.capabilities) ? skill.capabilities : [],
    }),
    source: 'stored',
    sourceUrl: skill.sourceUrl,
    sourceFormat: skill.sourceFormat,
    author: skill.author,
    version: skill.version,
    homepage: skill.homepage,
    primaryEnv: skill.primaryEnv,
    skillKey: skill.skillKey,
    always: skill.always === true,
    attached: attachedIds.has(skill.id),
    installOptions: skill.installOptions,
    skillRequirements: skill.skillRequirements,
    detectedEnvVars: skill.detectedEnvVars,
    security: skill.security,
    invocation: skill.invocation,
    commandDispatch: skill.commandDispatch,
    frontmatter: skill.frontmatter,
    priority: SOURCE_PRIORITY.stored,
  }
}

function buildSeedFromDiscovered(skill: DiscoveredSkill): SkillSeed {
  const explicitToolNames = Array.isArray(skill.toolNames) ? skill.toolNames : []
  const toolNames = inferToolNames({
    name: skill.name,
    skillKey: skill.skillKey,
    explicit: explicitToolNames,
  })

  return {
    runtimeId: `runtime:${skill.source}:${buildSkillKey(skill)}`,
    name: skill.name,
    key: buildSkillKey(skill),
    filename: skill.filename,
    content: skill.content || '',
    description: skill.description || '',
    tags: dedup(Array.isArray(skill.tags) ? skill.tags : []),
    toolNames,
    capabilities: inferCapabilities({
      name: skill.name,
      description: skill.description,
      tags: skill.tags,
      toolNames,
      explicit: Array.isArray(skill.capabilities) ? skill.capabilities : [],
    }),
    source: skill.source,
    sourcePath: skill.sourcePath,
    sourceUrl: skill.sourceUrl,
    sourceFormat: skill.sourceFormat,
    author: skill.author,
    version: skill.version,
    homepage: skill.homepage,
    primaryEnv: skill.primaryEnv,
    skillKey: skill.skillKey,
    always: skill.always === true,
    attached: false,
    installOptions: skill.installOptions,
    skillRequirements: skill.skillRequirements,
    detectedEnvVars: skill.detectedEnvVars,
    security: skill.security,
    invocation: skill.invocation,
    commandDispatch: skill.commandDispatch,
    frontmatter: skill.frontmatter,
    priority: SOURCE_PRIORITY[skill.source],
  }
}

function mergeSeeds(seeds: SkillSeed[]): SkillSeed {
  const ordered = [...seeds].sort((a, b) => a.priority - b.priority)
  const winner = ordered[ordered.length - 1]
  const storedSeed = [...ordered].reverse().find((entry) => entry.storageId)
  return {
    ...winner,
    storageId: winner.storageId || storedSeed?.storageId,
    attached: ordered.some((entry) => entry.attached),
    always: ordered.some((entry) => entry.always),
    tags: dedup(ordered.flatMap((entry) => entry.tags || [])),
    toolNames: dedup(ordered.flatMap((entry) => entry.toolNames || [])),
    capabilities: dedup(ordered.flatMap((entry) => entry.capabilities || [])),
    invocation: [...ordered].reverse().find((entry) => entry.invocation)?.invocation || null,
    commandDispatch: [...ordered].reverse().find((entry) => entry.commandDispatch)?.commandDispatch || null,
  }
}

function scoreSkillForRuntime(seed: SkillSeed, status: RuntimeSkillStatus, enabledPluginSet: Set<string>): {
  autoMatch: boolean
  score: number
  matchReasons: string[]
} {
  let score = 0
  const reasons: string[] = []
  const matchingTools = seed.toolNames.filter((toolName) => enabledPluginSet.has(normalizePluginId(toolName)))
  if (matchingTools.length > 0) {
    score += 45 + matchingTools.length
    reasons.push(`matches tools: ${matchingTools.join(', ')}`)
  }
  if (seed.attached) {
    score += 80
    reasons.push('attached to agent')
  }
  if (seed.always) {
    score += 40
    reasons.push('always-on')
  }
  if (status.eligible) score += 8
  if (!status.eligible && status.installRequired) score += 2
  return {
    autoMatch: matchingTools.length > 0,
    score,
    matchReasons: reasons,
  }
}

function toResolvedSkill(seed: SkillSeed, status: RuntimeSkillStatus, match: {
  autoMatch: boolean
  score: number
  matchReasons: string[]
}, options: {
  enabledPluginSet: Set<string>
  selected: boolean
}): ResolvedRuntimeSkill {
  const missing = formatMissing(status)
  const state: ResolvedRuntimeSkill['status'] = status.eligible
    ? 'ready'
    : status.installRequired
      ? 'needs_install'
      : 'blocked'

  const dispatch = seed.commandDispatch?.kind === 'tool' ? seed.commandDispatch : null
  const dispatchToolAvailable = dispatch
    ? options.enabledPluginSet.has(normalizePluginId(dispatch.toolName))
      || options.enabledPluginSet.has(dispatch.toolName)
    : false
  const dispatchBlocker = dispatch
    ? !dispatchToolAvailable
      ? `dispatch tool ${dispatch.toolName} is not enabled in this session`
      : !status.eligible
        ? missing.length > 0
          ? `skill is not ready: ${missing.join(', ')}`
          : 'skill is not ready in this environment'
        : null
    : null
  const executionMode: ResolvedRuntimeSkill['executionMode'] = dispatch ? 'dispatch' : 'prompt'
  const runnable = executionMode === 'dispatch' && status.eligible && dispatchToolAvailable

  return {
    id: seed.runtimeId,
    key: seed.key,
    storageId: seed.storageId,
    name: seed.name,
    filename: seed.filename,
    content: seed.content,
    description: seed.description,
    tags: seed.tags,
    toolNames: seed.toolNames,
    capabilities: seed.capabilities,
    source: seed.source,
    sourcePath: seed.sourcePath,
    sourceUrl: seed.sourceUrl,
    sourceFormat: seed.sourceFormat,
    author: seed.author,
    version: seed.version,
    homepage: seed.homepage,
    primaryEnv: seed.primaryEnv,
    skillKey: seed.skillKey,
    always: seed.always,
    attached: seed.attached,
    managed: Boolean(seed.storageId),
    installOptions: seed.installOptions,
    skillRequirements: seed.skillRequirements,
    detectedEnvVars: seed.detectedEnvVars,
    security: seed.security,
    invocation: seed.invocation,
    commandDispatch: seed.commandDispatch,
    frontmatter: seed.frontmatter,
    eligible: status.eligible,
    missing,
    reasons: status.reasons,
    status: state,
    configChecks: status.configChecks,
    autoMatch: match.autoMatch,
    matchReasons: match.matchReasons,
    score: match.score,
    selected: options.selected,
    executionMode,
    runnable,
    dispatchToolAvailable,
    dispatchBlocker,
  }
}

export function resolveRuntimeSkills(options: ResolveRuntimeSkillsOptions = {}): RuntimeSkillSnapshot {
  const storedSkills = options.storedSkills || loadSkills()
  const attachedIds = new Set(Array.isArray(options.agentSkillIds) ? options.agentSkillIds.filter(Boolean) : [])
  const discovered = discoverSkills({ cwd: options.cwd || undefined })
  const seeds = [
    ...Object.values(storedSkills).map((skill) => buildSeedFromStored(skill, attachedIds)),
    ...discovered.map((skill) => buildSeedFromDiscovered(skill)),
  ]

  const grouped = new Map<string, SkillSeed[]>()
  for (const seed of seeds) {
    const current = grouped.get(seed.key) || []
    current.push(seed)
    grouped.set(seed.key, current)
  }

  const enabledPluginSet = new Set(
    expandPluginIds(Array.isArray(options.enabledPlugins) ? options.enabledPlugins : [])
      .map((entry) => normalizePluginId(entry))
      .filter(Boolean),
  )
  const selectedSkillSelector = normalizeKey(options.selectedSkillId || '')

  const skills = [...grouped.values()]
    .map((entries) => {
      const merged = mergeSeeds(entries)
      const status = evaluateSkillStatus(merged)
      const match = scoreSkillForRuntime(merged, status, enabledPluginSet)
      const selected = Boolean(
        selectedSkillSelector
        && [
          merged.runtimeId,
          merged.storageId,
          merged.key,
          merged.name,
          merged.skillKey,
        ].some((value) => normalizeKey(value || '') === selectedSkillSelector),
      )
      return toResolvedSkill(merged, status, match, {
        enabledPluginSet,
        selected,
      })
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return a.name.localeCompare(b.name)
    })

  const promptSkills = selectPromptSkills(skills)
  const selectedSkill = skills.find((skill) => skill.selected) || null
  const promptIds = new Set(promptSkills.map((skill) => skill.id))
  return {
    skills,
    promptSkills,
    selectedSkill,
    attachedSkills: skills.filter((skill) => skill.attached),
    autoMatchedSkills: skills.filter((skill) => skill.autoMatch),
    availableSkills: skills.filter((skill) => !promptIds.has(skill.id) && !skill.selected),
  }
}

function selectPromptSkills(skills: ResolvedRuntimeSkill[]): ResolvedRuntimeSkill[] {
  const ordered = [...skills]
    .filter((skill) =>
      (skill.attached || skill.always)
      && typeof skill.content === 'string'
      && skill.content.trim(),
    )
    .sort((a, b) => {
      const priorityA = (a.attached ? 1000 : 0) + (a.always ? 500 : 0) + a.score
      const priorityB = (b.attached ? 1000 : 0) + (b.always ? 500 : 0) + b.score
      if (priorityB !== priorityA) return priorityB - priorityA
      return a.name.localeCompare(b.name)
    })

  const selected: ResolvedRuntimeSkill[] = []
  let totalChars = 0
  for (const skill of ordered) {
    if (selected.length >= MAX_SKILLS_IN_PROMPT) break
    const contentLen = skill.name.length + skill.content.length + 12
    if (totalChars + contentLen > MAX_SKILLS_PROMPT_CHARS) continue
    totalChars += contentLen
    selected.push(skill)
  }
  return selected
}

function sectionFromSkills(params: {
  title: string
  preface: string
  skills: ResolvedRuntimeSkill[]
}): string {
  const usable = params.skills.filter((skill) => skill.content.trim())
  if (usable.length === 0) return ''
  const body = usable
    .map((skill) => `### ${skill.name}\n${skill.content}`)
    .join('\n\n')
  return [params.title, params.preface, '', body].join('\n')
}

export function buildRuntimeSkillPromptBlocks(snapshot: RuntimeSkillSnapshot): string[] {
  const selectedId = snapshot.selectedSkill?.id || null
  const blocks = [
    buildSkillRuntimeInstructionBlock(snapshot),
    sectionFromSkills({
      title: '## Active Selected Skill',
      preface: [
        'This skill was already selected for the current task.',
        'Keep using it unless the task materially changes or the tool result proves it is the wrong fit.',
      ].join('\n'),
      skills: snapshot.selectedSkill ? [snapshot.selectedSkill] : [],
    }),
    sectionFromSkills({
      title: '## Pinned Skills',
      preface: [
        'Before responding, check these pinned or always-on skills first.',
        'They are the only skills included in the prompt before explicit selection.',
        'Other skills stay discoverable below and should be selected on demand through `use_skill`.',
      ].join('\n'),
      skills: snapshot.promptSkills.filter((skill) => !selectedId || skill.id !== selectedId),
    }),
    ...buildAvailableSkillBlocks(snapshot.availableSkills),
  ]
  return blocks.filter(Boolean)
}

function buildSkillRuntimeInstructionBlock(snapshot: RuntimeSkillSnapshot): string {
  const availableCount = snapshot.availableSkills.length + (snapshot.selectedSkill ? 1 : 0) + snapshot.promptSkills.length
  if (availableCount === 0) return ''
  return [
    '## Skill Runtime',
    'Before replying: scan the available skill names and descriptions below.',
    '- If exactly one skill clearly applies, call `use_skill` with `action=\"select\"` for that skill.',
    '- If the selected skill shows `mode=dispatch`, call `use_skill` with `action=\"run\"` so it dispatches through its bound tool.',
    '- If the selected skill shows `mode=prompt`, call `use_skill` with `action=\"load\"` once, then follow the loaded guidance.',
    '- Do not load more than one non-pinned skill up front.',
    '- Use `manage_skills` only for installation, attachment, or broader discovery/install management.',
  ].join('\n')
}

function buildAvailableSkillBlocks(skills: ResolvedRuntimeSkill[]): string[] {
  const lines = skills
    .slice(0, 12)
    .map((skill) => {
      const status = skill.status === 'ready'
        ? 'ready'
        : skill.missing.length > 0
          ? `needs ${skill.missing.join(', ')}`
          : skill.status
      const hint = skill.description ? `: ${(skill.description || '').slice(0, 120)}` : ''
      const mode = skill.executionMode === 'dispatch'
        ? skill.dispatchToolAvailable
          ? `mode=dispatch tool=${skill.commandDispatch?.toolName}`
          : `mode=dispatch blocked=${skill.dispatchBlocker || 'tool unavailable'}`
        : 'mode=prompt'
      return `- **${skill.name}** [${status}; ${mode}]${hint}`
    })
  return lines.length > 0
    ? [[
      '## Available Skills',
      'Local skills are discoverable by default. Select one on demand with `use_skill` instead of loading many skill bodies into the prompt.',
      '',
      lines.join('\n'),
    ].join('\n')]
    : []
}

export function recommendRuntimeSkillsForTask(
  skills: ResolvedRuntimeSkill[],
  task: string,
  enabledPlugins?: string[] | null,
): RuntimeSkillRecommendation[] {
  const queryTerms = new Set(tokenize(task))
  const enabledPluginSet = new Set(
    expandPluginIds(Array.isArray(enabledPlugins) ? enabledPlugins : [])
      .map((entry) => normalizePluginId(entry))
      .filter(Boolean),
  )

  return skills
    .map((skill) => {
      let score = skill.score
      const reasons = [...skill.matchReasons]
      const exactNameHit = queryTerms.has(normalizeKey(skill.name))
        || queryTerms.has(normalizeKey(skill.skillKey || ''))
      if (exactNameHit) {
        score += 35
        reasons.push('task mentions the skill directly')
      }
      const nameOverlap = scoreOverlap(tokenize(skill.name), queryTerms)
      if (nameOverlap > 0) {
        score += nameOverlap * 10
        reasons.push('name overlaps task keywords')
      }
      const capabilityOverlap = scoreOverlap(skill.capabilities, queryTerms)
      if (capabilityOverlap > 0) {
        score += capabilityOverlap * 6
        reasons.push('capabilities overlap task keywords')
      }
      const tagOverlap = scoreOverlap(skill.tags, queryTerms)
      if (tagOverlap > 0) {
        score += tagOverlap * 4
      }
      const descriptionOverlap = scoreOverlap(tokenize(skill.description), queryTerms)
      if (descriptionOverlap > 0) {
        score += descriptionOverlap * 3
      }
      const toolOverlap = skill.toolNames.filter((toolName) => enabledPluginSet.has(normalizePluginId(toolName)))
      if (toolOverlap.length > 0) {
        score += toolOverlap.length * 8
      }
      if (skill.attached) score += 12
      if (skill.eligible) score += 6
      return {
        skill,
        score,
        reasons: dedup(reasons),
      }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return a.skill.name.localeCompare(b.skill.name)
    })
}

export function findResolvedSkill(
  skills: ResolvedRuntimeSkill[],
  selector: string,
): ResolvedRuntimeSkill | null {
  const normalized = normalizeKey(selector)
  if (!normalized) return null
  return skills.find((skill) =>
    normalizeKey(skill.id) === normalized
    || normalizeKey(skill.storageId || '') === normalized
    || normalizeKey(skill.key) === normalized
    || normalizeKey(skill.name) === normalized
    || normalizeKey(skill.skillKey || '') === normalized,
  ) || null
}
