import fs from 'node:fs'
import path from 'node:path'
import { WORKSPACE_DIR } from './data-dir'

type SchedulePayload = Record<string, unknown>

export interface NormalizeScheduleOptions {
  cwd?: string | null
  now?: number
}

export type NormalizeScheduleResult =
  | { ok: true; value: SchedulePayload }
  | { ok: false; error: string }

const SCRIPT_FILE_EXT = /\.(py|js|mjs|cjs|ts|tsx|sh|bash|zsh|rb|php|pl)$/i
const DIRECT_SCRIPT_RUNNERS = new Set(['python', 'python3', 'python3.11', 'node', 'bash', 'sh', 'zsh', 'ruby', 'tsx', 'ts-node'])
const VALID_STATUSES = new Set(['active', 'paused', 'completed', 'failed'])

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeScheduleType(value: unknown): 'cron' | 'interval' | 'once' {
  if (value === 'cron' || value === 'interval' || value === 'once') return value
  return 'interval'
}

function normalizePositiveInt(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : Number.NaN
  if (!Number.isFinite(parsed)) return null
  const intValue = Math.trunc(parsed)
  return intValue > 0 ? intValue : null
}

function isWithinDirectory(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function resolveRelativePath(baseDir: string, candidate: string): string | null {
  const trimmed = trimString(candidate)
  if (!trimmed) return null
  if (path.isAbsolute(trimmed)) {
    const resolvedAbsolute = path.resolve(trimmed)
    return isWithinDirectory(baseDir, resolvedAbsolute) ? resolvedAbsolute : null
  }
  const resolved = path.resolve(baseDir, trimmed)
  return isWithinDirectory(baseDir, resolved) ? resolved : null
}

function tokenizeCommand(command: string): string[] {
  return String(command || '').match(/(?:[^\s"'`]+|"[^"]*"|'[^']*')+/g) || []
}

function unquoteToken(token: string): string {
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith('\'') && token.endsWith('\''))) {
    return token.slice(1, -1)
  }
  return token
}

function looksLikeScriptPath(token: string): boolean {
  return SCRIPT_FILE_EXT.test(token) || token.includes('/') || token.includes(path.sep)
}

function extractScriptPathFromCommand(command: string): string | null {
  const tokens = tokenizeCommand(command).map(unquoteToken).filter(Boolean)
  if (!tokens.length) return null

  const commandName = path.basename(tokens[0] || '').toLowerCase()
  let startIndex = 1
  if (commandName === 'npx' && tokens[1]) {
    const nestedRunner = path.basename(tokens[1]).toLowerCase()
    if (nestedRunner === 'tsx' || nestedRunner === 'ts-node') startIndex = 2
  } else if (commandName === 'deno' && tokens[1] === 'run') {
    startIndex = 2
  } else if (!DIRECT_SCRIPT_RUNNERS.has(commandName)) {
    startIndex = 0
  }

  for (let index = startIndex; index < tokens.length; index += 1) {
    const candidate = tokens[index]
    if (!candidate || candidate.startsWith('-')) continue
    if (!looksLikeScriptPath(candidate)) continue
    return candidate
  }

  return null
}

function deriveTaskPrompt(payload: SchedulePayload): string {
  const explicitTaskPrompt = trimString(payload.taskPrompt)
  if (explicitTaskPrompt) return explicitTaskPrompt

  const command = trimString(payload.command)
  if (command) {
    return `Execute the command \`${command}\` from this schedule's working directory and report the result, including any errors.`
  }

  const filePath = trimString(payload.path)
  if (!filePath) return ''

  const action = trimString(payload.action).toLowerCase()
  if (action === 'run_script') {
    return `Run the script at \`${filePath}\` from this schedule's working directory and report the result, including any errors.`
  }

  return `Use the file at \`${filePath}\` to complete this scheduled task and report the result.`
}

function validateScheduleArtifacts(payload: SchedulePayload, baseDir: string): string | null {
  const action = trimString(payload.action).toLowerCase()
  const filePath = trimString(payload.path)
  const command = trimString(payload.command)

  if (action === 'run_script' && !filePath) {
    return 'run_script schedules require a path.'
  }

  if (filePath) {
    const resolved = resolveRelativePath(baseDir, filePath)
    if (!resolved) return `schedule path must stay inside ${baseDir}: ${filePath}`
    if (!fs.existsSync(resolved)) return `schedule path not found: ${filePath}`
  }

  if (!command) return null
  const commandScriptPath = extractScriptPathFromCommand(command)
  if (!commandScriptPath) return null
  const resolved = resolveRelativePath(baseDir, commandScriptPath)
  if (!resolved) return `schedule command references a path outside ${baseDir}: ${commandScriptPath}`
  if (!fs.existsSync(resolved)) return `schedule command references a missing file: ${commandScriptPath}`
  return null
}

export function normalizeSchedulePayload(payload: SchedulePayload, opts: NormalizeScheduleOptions = {}): NormalizeScheduleResult {
  const now = typeof opts.now === 'number' ? opts.now : Date.now()
  const baseDir = path.resolve(trimString(opts.cwd) || WORKSPACE_DIR)
  const normalized: SchedulePayload = {
    ...payload,
    scheduleType: normalizeScheduleType(payload.scheduleType),
  }
  const action = trimString(normalized.action)
  const command = trimString(normalized.command)
  const filePath = trimString(normalized.path)
  if (action) normalized.action = action
  if (command) normalized.command = command
  if (filePath) normalized.path = filePath

  const status = trimString(normalized.status).toLowerCase()
  normalized.status = VALID_STATUSES.has(status) ? status : 'active'

  const agentId = trimString(normalized.agentId)
  if (!agentId) {
    return { ok: false, error: 'Error: schedules require a target agentId.' }
  }
  normalized.agentId = agentId

  const taskPrompt = deriveTaskPrompt(normalized)
  if (!taskPrompt) {
    return { ok: false, error: 'Error: schedules require a taskPrompt, command, or action/path payload.' }
  }
  normalized.taskPrompt = taskPrompt

  const validationError = validateScheduleArtifacts(normalized, baseDir)
  if (validationError) return { ok: false, error: `Error: ${validationError}` }

  if (normalized.nextRunAt == null) {
    if (normalized.scheduleType === 'once') {
      const runAt = normalizePositiveInt(normalized.runAt)
      if (runAt != null) normalized.nextRunAt = runAt
    } else if (normalized.scheduleType === 'interval') {
      const intervalMs = normalizePositiveInt(normalized.intervalMs)
      if (intervalMs != null) normalized.nextRunAt = now + intervalMs
    }
  }

  return { ok: true, value: normalized }
}

export function extractScheduleCommandScriptPath(command: string): string | null {
  return extractScriptPathFromCommand(command)
}
