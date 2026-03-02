function resolveLocalTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

function formatDateTimeInTimezone(date: Date, timezone: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: timezone,
      timeZoneName: 'short',
    }).format(date)
  } catch {
    return null
  }
}

export function buildCurrentDateTimePromptContext(preferredTimezone?: string | null): string {
  const now = new Date()
  const utcIso = now.toISOString()
  const utcFormatted = formatDateTimeInTimezone(now, 'UTC') || utcIso
  const localTimezone = resolveLocalTimezone()
  const requestedTimezone = (preferredTimezone || '').trim()
  const chosenTimezone = requestedTimezone || localTimezone
  const chosenFormatted = formatDateTimeInTimezone(now, chosenTimezone)

  const lines = [
    '## Runtime Date/Time Context',
    `- Current timestamp (UTC): ${utcIso}`,
    `- Current date/time (UTC): ${utcFormatted}`,
  ]

  if (chosenFormatted) {
    lines.push(`- Current date/time (${chosenTimezone}): ${chosenFormatted}`)
  } else if (requestedTimezone) {
    lines.push(`- Requested timezone "${requestedTimezone}" could not be resolved. Use UTC time above.`)
  }

  lines.push('- Treat these as authoritative for terms like "today", "yesterday", "tomorrow", and "recent".')
  lines.push('- For time-sensitive answers, use explicit dates (for example, "March 2, 2026").')

  return lines.join('\n')
}
