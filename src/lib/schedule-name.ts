const MAX_SCHEDULE_NAME_LENGTH = 80

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function truncate(value: string, maxLength = MAX_SCHEDULE_NAME_LENGTH): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`
}

function isGenericName(name: string): boolean {
  const normalized = normalizeWhitespace(name).toLowerCase()
  return normalized === '' || normalized === 'schedule' || normalized === 'new schedule' || normalized === 'unnamed schedule'
}

function deriveFromPrompt(taskPrompt: string): string {
  const prompt = normalizeWhitespace(taskPrompt)
  if (!prompt) return 'Scheduled Task'

  const lower = prompt.toLowerCase()
  if (lower.includes('wikipedia') && (lower.includes('screenshot') || lower.includes('screen shot'))) {
    return 'Wikipedia Screenshot'
  }
  if (lower.includes('screenshot')) {
    return 'Screenshot Task'
  }
  if (lower.includes('backup')) {
    return 'Backup Task'
  }
  if (lower.includes('health check') || lower.includes('heartbeat')) {
    return 'Health Check'
  }
  if (lower.includes('report')) {
    return 'Report Task'
  }

  const firstLine = prompt.split('\n')[0] || prompt
  const firstClause = firstLine.split(/[.,;:!?]/)[0] || firstLine
  const cleaned = normalizeWhitespace(
    firstClause
      .replace(/^(please\s+)?(can you|could you|would you)\s+/i, '')
      .replace(/^(create|make|set up|setup|schedule|run|execute|trigger|perform|generate|send|take|capture|navigate|go|open|check|monitor|fetch|pull|build|test)\b\s*/i, '')
      .replace(/^to\s+/i, ''),
  )
  if (!cleaned) return 'Scheduled Task'
  return `${cleaned.charAt(0).toUpperCase()}${cleaned.slice(1)}`
}

export function resolveScheduleName(input: {
  name?: unknown
  taskPrompt?: unknown
}): string {
  const providedName = typeof input.name === 'string' ? normalizeWhitespace(input.name) : ''
  if (providedName && !isGenericName(providedName)) {
    return truncate(providedName)
  }

  const taskPrompt = typeof input.taskPrompt === 'string' ? input.taskPrompt : ''
  return truncate(deriveFromPrompt(taskPrompt))
}

