import type { OpenClawSkillEntry, SkillInstallOption, SkillRequirements } from '@/types'

interface GatewayConfigCheck {
  path?: string
  satisfied?: boolean
}

interface GatewayInstallOption {
  kind?: string
  label?: string
  bins?: string[]
}

interface GatewaySkillRequirements {
  bins?: string[]
  anyBins?: string[][]
  env?: string[]
  config?: string[]
  os?: string[]
}

interface GatewaySkillEntry {
  name?: string
  description?: string
  source?: string
  eligible?: boolean
  requirements?: GatewaySkillRequirements
  missing?: GatewaySkillRequirements
  disabled?: boolean
  install?: GatewayInstallOption[]
  configChecks?: GatewayConfigCheck[]
  skillKey?: string
  baseDir?: string
}

interface GatewaySkillsStatusPayload {
  skills?: GatewaySkillEntry[]
}

function uniq(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map((value) => (value ?? '').trim()).filter(Boolean))]
}

function normalizeSource(source: string | undefined): OpenClawSkillEntry['source'] {
  switch ((source ?? '').trim()) {
    case 'openclaw-bundled':
    case 'bundled':
      return 'bundled'
    case 'managed':
      return 'managed'
    case 'personal':
      return 'personal'
    case 'workspace':
      return 'workspace'
    default:
      return 'workspace'
  }
}

function normalizeInstallOptions(install: GatewayInstallOption[] | undefined): SkillInstallOption[] | undefined {
  if (!Array.isArray(install) || !install.length) return undefined
  const normalized = install
    .map((entry) => {
      const kind = (entry.kind ?? '').trim()
      if (!kind || !entry.label?.trim()) return null
      if (!['brew', 'node', 'go', 'uv', 'download'].includes(kind)) return null
      return {
        kind: kind as SkillInstallOption['kind'],
        label: entry.label.trim(),
        bins: Array.isArray(entry.bins) ? uniq(entry.bins) : undefined,
      } satisfies SkillInstallOption
    })
    .filter((value): value is NonNullable<typeof value> => value !== null)
  return normalized.length ? normalized : undefined
}

function normalizeRequirements(input: GatewaySkillRequirements | undefined): SkillRequirements | undefined {
  if (!input || typeof input !== 'object') return undefined
  const bins = Array.isArray(input.bins) ? uniq(input.bins) : undefined
  const anyBins = Array.isArray(input.anyBins)
    ? input.anyBins
        .map((group) => Array.isArray(group) ? uniq(group) : [])
        .filter((group) => group.length > 0)
    : undefined
  const env = Array.isArray(input.env) ? uniq(input.env) : undefined
  const config = Array.isArray(input.config) ? uniq(input.config) : undefined
  const os = Array.isArray(input.os) ? uniq(input.os) : undefined
  if (!bins && !anyBins && !env && !config && !os) return undefined
  return { bins, anyBins, env, config, os }
}

function flattenMissing(input: GatewaySkillRequirements | undefined): string[] | undefined {
  if (!input || typeof input !== 'object') return undefined
  const out: string[] = []
  for (const value of Array.isArray(input.bins) ? uniq(input.bins) : []) out.push(value)
  for (const group of Array.isArray(input.anyBins) ? input.anyBins : []) {
    const normalized = Array.isArray(group) ? uniq(group) : []
    if (normalized.length) out.push(`one of: ${normalized.join(' | ')}`)
  }
  for (const value of Array.isArray(input.env) ? uniq(input.env) : []) out.push(`env ${value}`)
  for (const value of Array.isArray(input.config) ? uniq(input.config) : []) out.push(`config ${value}`)
  for (const value of Array.isArray(input.os) ? uniq(input.os) : []) out.push(`os ${value}`)
  return out.length ? out : undefined
}

export function normalizeOpenClawSkillsPayload(payload: unknown): OpenClawSkillEntry[] {
  const rawSkills = Array.isArray(payload)
    ? payload as GatewaySkillEntry[]
    : Array.isArray((payload as GatewaySkillsStatusPayload | null | undefined)?.skills)
      ? (payload as GatewaySkillsStatusPayload).skills!
      : []

  return rawSkills
    .map((skill) => {
      const name = skill.name?.trim()
      if (!name) return null
      return {
        name,
        description: skill.description?.trim() || undefined,
        source: normalizeSource(skill.source),
        eligible: skill.eligible === true,
        missing: flattenMissing(skill.missing),
        disabled: skill.disabled === true,
        installOptions: normalizeInstallOptions(skill.install),
        skillRequirements: normalizeRequirements(skill.requirements),
        configChecks: Array.isArray(skill.configChecks)
          ? skill.configChecks
              .filter((check) => check.path?.trim())
              .map((check) => ({ key: check.path!.trim(), ok: check.satisfied === true }))
          : undefined,
        skillKey: skill.skillKey?.trim() || undefined,
        baseDir: skill.baseDir?.trim() || undefined,
      } satisfies OpenClawSkillEntry
    })
    .filter((skill): skill is NonNullable<typeof skill> => skill !== null)
}
