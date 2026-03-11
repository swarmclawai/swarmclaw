import path from 'path'
import type {
  SkillCommandDispatch,
  SkillInstallOption,
  SkillInvocationConfig,
  SkillRequirements,
  SkillSecuritySummary,
} from '@/types'
import { dedup } from '@/lib/shared-utils'

export type SkillSourceFormat = 'openclaw' | 'plain'

type NormalizeSkillInput = {
  name?: unknown
  description?: unknown
  filename?: unknown
  content?: unknown
  sourceUrl?: unknown
  sourceFormat?: unknown
  author?: unknown
  tags?: unknown
  version?: unknown
  homepage?: unknown
  primaryEnv?: unknown
  skillKey?: unknown
  toolNames?: unknown
  capabilities?: unknown
  always?: unknown
  installOptions?: unknown
  skillRequirements?: unknown
  detectedEnvVars?: unknown
  security?: unknown
  invocation?: unknown
  commandDispatch?: unknown
  frontmatter?: unknown
}

export type NormalizedSkill = {
  name: string
  description: string
  filename: string
  content: string
  sourceUrl?: string
  sourceFormat: SkillSourceFormat
  author?: string
  tags?: string[]
  version?: string
  homepage?: string
  primaryEnv?: string | null
  skillKey?: string | null
  toolNames?: string[]
  capabilities?: string[]
  always?: boolean
  installOptions?: SkillInstallOption[]
  skillRequirements?: SkillRequirements
  detectedEnvVars?: string[]
  security?: SkillSecuritySummary | null
  invocation?: SkillInvocationConfig | null
  commandDispatch?: SkillCommandDispatch | null
  frontmatter?: Record<string, unknown> | null
}

type ParsedFrontmatter = {
  frontmatter: Record<string, unknown>
  body: string
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value
    .map((item) => asTrimmedString(item))
    .filter((item): item is string => Boolean(item))
  return items.length ? items : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (value.trim().toLowerCase() === 'true') return true
    if (value.trim().toLowerCase() === 'false') return false
  }
  return undefined
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
    return value.slice(1, -1)
  }
  return value
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'skill'
}

function sanitizeFilename(input: string): string {
  const base = path.basename(input.trim())
  const safe = base.replace(/[^a-zA-Z0-9._-]/g, '-')
  if (!safe) return 'skill.md'
  return safe.toLowerCase().endsWith('.md') ? safe : `${safe}.md`
}

function deriveNameFromFilename(filename: string): string {
  return filename
    .replace(/\.md$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim() || 'Unnamed Skill'
}

function deriveFilenameFromUrl(url: string): string | null {
  try {
    const u = new URL(url)
    const basename = path.basename(u.pathname)
    if (!basename) return null
    if (basename.toUpperCase() === 'SKILL.MD') {
      const parent = path.basename(path.dirname(u.pathname))
      if (parent) return `${slugify(parent)}.md`
    }
    return sanitizeFilename(basename)
  } catch {
    return null
  }
}

function parseInlineArray(value: string): unknown[] {
  const inner = value.slice(1, -1).trim()
  if (!inner) return []
  return inner
    .split(',')
    .map((part) => parseScalar(part.trim()))
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('\'') && trimmed.endsWith('\''))) {
    return stripQuotes(trimmed)
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return parseInlineArray(trimmed)
  }
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true'
  if (/^(null|~)$/i.test(trimmed)) return null
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed)
  return trimmed
}

function nextNestedContainer(lines: string[], start: number, currentIndent: number): Record<string, unknown> | unknown[] {
  for (let index = start + 1; index < lines.length; index += 1) {
    const raw = lines[index]
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const indent = raw.match(/^\s*/)?.[0]?.length || 0
    if (indent <= currentIndent) break
    return trimmed.startsWith('- ') ? [] : {}
  }
  return {}
}

function parseFrontmatterData(rawFrontmatter: string): Record<string, unknown> {
  const lines = rawFrontmatter.split(/\r?\n/)
  const root: Record<string, unknown> = {}
  const stack: Array<{ indent: number; value: Record<string, unknown> | unknown[] }> = [{ indent: -1, value: root }]

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index]
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const indent = rawLine.match(/^\s*/)?.[0]?.length || 0

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop()
    }

    const parent = stack[stack.length - 1]?.value
    if (!parent) continue

    if (trimmed.startsWith('- ')) {
      if (!Array.isArray(parent)) continue
      const rest = trimmed.slice(2).trim()
      if (!rest) {
        const container = nextNestedContainer(lines, index, indent)
        parent.push(container)
        stack.push({ indent, value: container })
        continue
      }

      const objectItemMatch = rest.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/)
      if (objectItemMatch) {
        const [, key, rawValue] = objectItemMatch
        const objectItem: Record<string, unknown> = {}
        if (rawValue.trim()) {
          objectItem[key] = parseScalar(rawValue)
          parent.push(objectItem)
          stack.push({ indent, value: objectItem })
        } else {
          const container = nextNestedContainer(lines, index, indent)
          objectItem[key] = container
          parent.push(objectItem)
          stack.push({ indent, value: objectItem })
          stack.push({ indent: indent + 1, value: container })
        }
        continue
      }

      parent.push(parseScalar(rest))
      continue
    }

    if (Array.isArray(parent)) continue

    const keyMatch = trimmed.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/)
    if (!keyMatch) continue
    const [, key, rawValue] = keyMatch
    if (rawValue.trim()) {
      parent[key] = parseScalar(rawValue)
      continue
    }
    const container = nextNestedContainer(lines, index, indent)
    parent[key] = container
    stack.push({ indent, value: container })
  }

  return root
}

function parseFrontmatterBlock(content: string): ParsedFrontmatter | null {
  const match = content.match(/^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return null
  const rawFrontmatter = match[1]
  const body = match[2] || ''
  return {
    frontmatter: parseFrontmatterData(rawFrontmatter),
    body,
  }
}

function normalizeInstallOptions(value: unknown): SkillInstallOption[] | undefined {
  if (!Array.isArray(value)) return undefined
  const normalized: SkillInstallOption[] = value.flatMap((entry) => {
      const row = asObject(entry)
      if (!row) return []
      const kind = asTrimmedString(row.kind)
      const label = asTrimmedString(row.label)
        || asTrimmedString(row.formula)
        || asTrimmedString(row.package)
        || asTrimmedString(row.url)
      if (!kind || !label) return []
      if (!['brew', 'node', 'go', 'uv', 'download'].includes(kind)) return []
      return [{
        kind: kind as SkillInstallOption['kind'],
        label,
        bins: asStringArray(row.bins),
      } satisfies SkillInstallOption]
    })
  return normalized.length ? normalized : undefined
}

function normalizeRequirements(value: unknown): SkillRequirements | undefined {
  const source = asObject(value)
  if (!source) return undefined
  const requires = asObject(source.requires) || source
  const anyBins = Array.isArray(requires.anyBins)
    ? requires.anyBins
        .map((group) => asStringArray(group) || [])
        .filter((group) => group.length > 0)
    : undefined
  const normalized: SkillRequirements = {
    bins: asStringArray(requires.bins),
    anyBins,
    env: asStringArray(requires.env),
    config: asStringArray(requires.config),
    os: asStringArray(source.os ?? requires.os),
  }
  if (!normalized.bins && !normalized.anyBins && !normalized.env && !normalized.config && !normalized.os) {
    return undefined
  }
  return normalized
}

function normalizeInvocationConfig(value: unknown): SkillInvocationConfig | null {
  const source = asObject(value)
  if (!source) return null
  const userInvocable = asBoolean(source.userInvocable ?? source.user_invocable)
  if (userInvocable === undefined) return null
  return { userInvocable }
}

function normalizeCommandDispatch(params: {
  frontmatter?: Record<string, unknown> | null
  runtimeMeta?: Record<string, unknown> | null
  input?: NormalizeSkillInput
}): SkillCommandDispatch | null {
  const inputDispatch = asObject(params.input?.commandDispatch)
  const inlineDispatch = asObject(params.frontmatter?.commandDispatch)
    || asObject(params.frontmatter?.command_dispatch)
    || asObject(params.runtimeMeta?.commandDispatch)
    || asObject(params.runtimeMeta?.command_dispatch)

  const kindRaw = asTrimmedString(
    inputDispatch?.kind
      ?? inlineDispatch?.kind
      ?? params.frontmatter?.['command-dispatch']
      ?? params.frontmatter?.command_dispatch
      ?? params.runtimeMeta?.['command-dispatch']
      ?? params.runtimeMeta?.command_dispatch,
  )
  if (!kindRaw || kindRaw.toLowerCase() !== 'tool') return null

  const toolName = asTrimmedString(
    inputDispatch?.toolName
      ?? inputDispatch?.tool_name
      ?? inlineDispatch?.toolName
      ?? inlineDispatch?.tool_name
      ?? params.frontmatter?.['command-tool']
      ?? params.frontmatter?.command_tool
      ?? params.runtimeMeta?.['command-tool']
      ?? params.runtimeMeta?.command_tool,
  )
  if (!toolName) return null

  const argModeRaw = asTrimmedString(
    inputDispatch?.argMode
      ?? inputDispatch?.arg_mode
      ?? inlineDispatch?.argMode
      ?? inlineDispatch?.arg_mode
      ?? params.frontmatter?.['command-arg-mode']
      ?? params.frontmatter?.command_arg_mode
      ?? params.runtimeMeta?.['command-arg-mode']
      ?? params.runtimeMeta?.command_arg_mode,
  )

  return {
    kind: 'tool',
    toolName,
    argMode: argModeRaw && argModeRaw.toLowerCase() === 'raw' ? 'raw' : 'raw',
  }
}

function pickRuntimeMetadata(frontmatter: Record<string, unknown>): Record<string, unknown> | null {
  const metadata = asObject(frontmatter.metadata)
  if (metadata) {
    const scoped = asObject(metadata.openclaw)
      || asObject(metadata.clawdbot)
      || asObject(metadata.clawdis)
    if (scoped) return scoped
  }
  return asObject(frontmatter.openclaw)
    || asObject(frontmatter.clawdbot)
    || asObject(frontmatter.clawdis)
}

function uniqueStrings(values: string[]): string[] {
  return dedup(values.map((value) => value.trim()).filter(Boolean))
}

function extractDetectedEnvVars(rawContent: string): string[] {
  const detected = new Set<string>()
  const patterns = [
    /process\.env\.([A-Z][A-Z0-9_]+)/g,
    /\$\{([A-Z][A-Z0-9_]+)\}/g,
    /\bexport\s+([A-Z][A-Z0-9_]+)\b/g,
  ]
  for (const pattern of patterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(rawContent)) !== null) {
      detected.add(match[1])
    }
  }
  return [...detected].sort()
}

function extractInstallCommands(rawContent: string): string[] {
  const commands: string[] = []
  for (const line of rawContent.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (
      /(brew install|npm install|pnpm add|yarn add|go install|uv tool install|curl .*\|\s*(?:bash|sh)|wget .*\|\s*(?:bash|sh))/i.test(trimmed)
    ) {
      commands.push(trimmed)
    }
  }
  return uniqueStrings(commands).slice(0, 8)
}

function buildSkillSecuritySummary(params: {
  rawContent: string
  requirements?: SkillRequirements
  installOptions?: SkillInstallOption[]
  primaryEnv?: string | null
}): SkillSecuritySummary | null {
  const detectedEnvVars = extractDetectedEnvVars(params.rawContent)
  const declaredEnv = new Set<string>([
    ...(params.requirements?.env || []),
    ...(params.primaryEnv ? [params.primaryEnv] : []),
  ])
  const missingDeclarations = detectedEnvVars.filter((name) => !declaredEnv.has(name))
  const installCommands = extractInstallCommands(params.rawContent)
  const notes: string[] = []

  if (missingDeclarations.length) {
    notes.push(`Detected env vars missing from frontmatter: ${missingDeclarations.join(', ')}`)
  }
  if (installCommands.length) {
    notes.push('Skill content includes install instructions or executable bootstrap commands.')
  }
  if ((params.installOptions?.length || 0) > 0) {
    notes.push('Skill declares install options that should be reviewed before enabling.')
  }
  if (/(curl .*\|\s*(?:bash|sh)|wget .*\|\s*(?:bash|sh)|sudo\s+)/i.test(params.rawContent)) {
    notes.push('Skill content includes high-risk shell patterns.')
  }

  if (!notes.length && !detectedEnvVars.length && !installCommands.length) return null

  const level: SkillSecuritySummary['level'] =
    notes.some((note) => /high-risk|missing from frontmatter/i.test(note))
      ? 'high'
      : installCommands.length || detectedEnvVars.length
        ? 'medium'
        : 'low'

  return {
    level,
    notes,
    detectedEnvVars,
    missingDeclarations,
    installCommands,
  }
}

export function normalizeSkillPayload(input: NormalizeSkillInput): NormalizedSkill {
  const rawContent = typeof input.content === 'string' ? input.content : ''
  const parsed = parseFrontmatterBlock(rawContent)
  const preservedFrontmatter = asObject(input.frontmatter)
  const frontmatter = parsed?.frontmatter || preservedFrontmatter || null
  const runtimeMeta = frontmatter ? pickRuntimeMetadata(frontmatter) : null

  const frontmatterName = asTrimmedString(frontmatter?.name)
  const frontmatterDescription = asTrimmedString(frontmatter?.description)
  const frontmatterAuthor = asTrimmedString(frontmatter?.author)
  const frontmatterTags = asStringArray(frontmatter?.tags)
  const version = asTrimmedString(frontmatter?.version)
    || asTrimmedString(runtimeMeta?.version)
    || asTrimmedString(input.version)
  const homepage = asTrimmedString(runtimeMeta?.homepage)
    || asTrimmedString(frontmatter?.homepage)
    || asTrimmedString(input.homepage)
  const primaryEnv = asTrimmedString(runtimeMeta?.primaryEnv)
    || asTrimmedString(input.primaryEnv)
    || null
  const skillKey = asTrimmedString(runtimeMeta?.skillKey)
    || asTrimmedString(input.skillKey)
    || null
  const toolNames = asStringArray(runtimeMeta?.toolNames)
    || asStringArray(runtimeMeta?.tools)
    || asStringArray(input.toolNames)
    || undefined
  const capabilities = asStringArray(runtimeMeta?.capabilities)
    || asStringArray(input.capabilities)
    || undefined
  const always = asBoolean(runtimeMeta?.always) ?? asBoolean(input.always)
  const installOptions = normalizeInstallOptions(runtimeMeta?.install)
    || normalizeInstallOptions(input.installOptions)
  const skillRequirements = normalizeRequirements(runtimeMeta)
    || normalizeRequirements(input.skillRequirements)
  const invocation = normalizeInvocationConfig(input.invocation)
    || normalizeInvocationConfig(frontmatter?.invocation)
    || normalizeInvocationConfig(runtimeMeta?.invocation)
  const commandDispatch = normalizeCommandDispatch({
    frontmatter,
    runtimeMeta,
    input,
  })

  const sourceUrl = asTrimmedString(input.sourceUrl) || undefined
  const initialFilename = asTrimmedString(input.filename)
    || (sourceUrl ? deriveFilenameFromUrl(sourceUrl) : null)
    || (frontmatterName ? `${slugify(frontmatterName)}.md` : null)
    || 'skill.md'
  const filename = sanitizeFilename(initialFilename)

  const name = asTrimmedString(input.name)
    || frontmatterName
    || deriveNameFromFilename(filename)

  const description = asTrimmedString(input.description)
    || frontmatterDescription
    || ''

  const author = asTrimmedString(input.author)
    || frontmatterAuthor
    || undefined

  const tags = asStringArray(input.tags)
    || frontmatterTags
    || undefined

  const normalizedContent = parsed ? parsed.body.trimStart() : rawContent
  const detectedEnvVars = extractDetectedEnvVars(rawContent)
  const preservedDetectedEnvVars = asStringArray(input.detectedEnvVars)
  const generatedSecurity = buildSkillSecuritySummary({
    rawContent,
    requirements: skillRequirements,
    installOptions,
    primaryEnv,
  })
  const securityRecord = asObject(input.security)
  const security = generatedSecurity || (securityRecord
    ? {
        level: securityRecord.level === 'high' || securityRecord.level === 'medium' ? securityRecord.level : 'low',
        notes: asStringArray(securityRecord.notes) || [],
        detectedEnvVars: asStringArray(securityRecord.detectedEnvVars),
        missingDeclarations: asStringArray(securityRecord.missingDeclarations),
        installCommands: asStringArray(securityRecord.installCommands),
      } satisfies SkillSecuritySummary
    : null)

  const sourceFormat: SkillSourceFormat = (parsed && (
    frontmatterName !== null
    || frontmatterDescription !== null
    || runtimeMeta !== null
  ))
    || input.sourceFormat === 'openclaw'
    || preservedFrontmatter !== null
    ? 'openclaw'
    : 'plain'

  return {
    name,
    description,
    filename,
    content: normalizedContent,
    sourceUrl,
    sourceFormat,
    author,
    tags,
    version: version || undefined,
    homepage: homepage || undefined,
    primaryEnv,
    skillKey,
    toolNames,
    capabilities,
    always,
    installOptions,
    skillRequirements,
    detectedEnvVars: detectedEnvVars.length ? detectedEnvVars : preservedDetectedEnvVars,
    security,
    invocation,
    commandDispatch,
    frontmatter,
  }
}
