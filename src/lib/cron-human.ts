const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const
const MONTH_NAMES = [
  '', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const

function formatTime(hour: number, minute: number): string {
  const period = hour >= 12 ? 'PM' : 'AM'
  const h = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour
  const m = minute.toString().padStart(2, '0')
  return `${h}:${m} ${period}`
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

function parseDowRange(field: string): string | null {
  // Normalize 7 → 0 (both mean Sunday)
  const normalized = field.replace(/7/g, '0')
  if (normalized === '1-5') return 'Weekdays'
  if (normalized === '0,6' || normalized === '6,0') return 'Weekends'
  // Single day
  const single = parseInt(normalized, 10)
  if (!isNaN(single) && single >= 0 && single <= 6) return `Every ${DAY_NAMES[single]}`
  // Comma-separated days
  if (/^[0-6](,[0-6])+$/.test(normalized)) {
    const days = normalized.split(',').map((d) => DAY_NAMES[parseInt(d, 10)])
    return days.join(', ')
  }
  // Range like 1-3
  const rangeMatch = normalized.match(/^([0-6])-([0-6])$/)
  if (rangeMatch) {
    const start = parseInt(rangeMatch[1], 10)
    const end = parseInt(rangeMatch[2], 10)
    return `${DAY_NAMES[start]} through ${DAY_NAMES[end]}`
  }
  return null
}

/**
 * Convert a 5-field cron expression to a human-readable string.
 * Falls back to the raw expression for patterns too complex to describe simply.
 */
export function cronToHuman(expression: string): string {
  const raw = expression.trim()
  const parts = raw.split(/\s+/)
  if (parts.length !== 5) return raw

  const [minute, hour, dom, month, dow] = parts

  // Every minute
  if (raw === '* * * * *') return 'Every minute'

  // Step minutes: */N * * * *
  if (/^\*\/\d+$/.test(minute) && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    const n = parseInt(minute.slice(2), 10)
    return n === 1 ? 'Every minute' : `Every ${n} minutes`
  }

  // Step hours: 0 */N * * *
  if (minute === '0' && /^\*\/\d+$/.test(hour) && dom === '*' && month === '*' && dow === '*') {
    const n = parseInt(hour.slice(2), 10)
    return n === 1 ? 'Every hour' : `Every ${n} hours`
  }

  // Fixed minute, every hour: M * * * *
  if (/^\d+$/.test(minute) && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    const m = parseInt(minute, 10)
    return m === 0 ? 'Every hour' : `Every hour at minute ${m}`
  }

  // From here, we need a fixed minute and hour
  const fixedMinute = /^\d+$/.test(minute) ? parseInt(minute, 10) : null
  const fixedHour = /^\d+$/.test(hour) ? parseInt(hour, 10) : null

  if (fixedMinute === null || fixedHour === null) return raw

  const time = formatTime(fixedHour, fixedMinute)
  const atTime = fixedHour === 0 && fixedMinute === 0 ? 'at midnight' : `at ${time}`

  // Specific day-of-week
  if (dom === '*' && month === '*' && dow !== '*') {
    const dowDesc = parseDowRange(dow)
    if (!dowDesc) return raw
    if (dowDesc === 'Weekdays' || dowDesc === 'Weekends') return `${dowDesc} ${atTime}`
    return `${dowDesc} ${atTime}`
  }

  // Specific day-of-month (any month)
  if (/^\d+$/.test(dom) && month === '*' && dow === '*') {
    const d = parseInt(dom, 10)
    return `${ordinal(d)} of every month ${atTime}`
  }

  // Specific month and day-of-month
  if (/^\d+$/.test(dom) && /^\d+$/.test(month) && dow === '*') {
    const d = parseInt(dom, 10)
    const mo = parseInt(month, 10)
    if (mo >= 1 && mo <= 12) {
      return `${MONTH_NAMES[mo]} ${ordinal(d)} ${atTime}`
    }
  }

  // Every day at specific time
  if (dom === '*' && month === '*' && dow === '*') {
    return `Every day ${atTime}`
  }

  // Fallback
  return raw
}
