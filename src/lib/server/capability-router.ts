import type { AppSettings } from '@/types'

export type TaskIntent =
  | 'coding'
  | 'research'
  | 'browsing'
  | 'outreach'
  | 'scheduling'
  | 'memory'
  | 'general'

export interface CapabilityRoutingDecision {
  intent: TaskIntent
  confidence: number
  preferredTools: string[]
  preferredDelegates: Array<'delegate_to_claude_code' | 'delegate_to_codex_cli' | 'delegate_to_opencode_cli'>
  primaryUrl?: string
}

function findFirstUrl(text: string): string | undefined {
  const m = text.match(/https?:\/\/[^\s<>"')]+/i)
  return m?.[0]
}

function containsAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term))
}

function normalizeDelegateOrder(
  value: unknown,
): Array<'delegate_to_claude_code' | 'delegate_to_codex_cli' | 'delegate_to_opencode_cli'> {
  const fallback: Array<'delegate_to_claude_code' | 'delegate_to_codex_cli' | 'delegate_to_opencode_cli'> = [
    'delegate_to_claude_code',
    'delegate_to_codex_cli',
    'delegate_to_opencode_cli',
  ]
  if (!Array.isArray(value) || !value.length) return fallback

  const mapped: Array<'delegate_to_claude_code' | 'delegate_to_codex_cli' | 'delegate_to_opencode_cli'> = []
  for (const raw of value) {
    if (raw === 'claude') mapped.push('delegate_to_claude_code')
    else if (raw === 'codex') mapped.push('delegate_to_codex_cli')
    else if (raw === 'opencode') mapped.push('delegate_to_opencode_cli')
  }
  if (!mapped.length) return fallback
  const deduped = Array.from(new Set(mapped))
  for (const tool of fallback) {
    if (!deduped.includes(tool)) deduped.push(tool)
  }
  return deduped
}

export function routeTaskIntent(
  message: string,
  enabledTools: string[],
  settings?: AppSettings | null,
): CapabilityRoutingDecision {
  const text = (message || '').toLowerCase()
  const url = findFirstUrl(message || '')
  const delegateOrder = normalizeDelegateOrder(settings?.autonomyPreferredDelegates)

  const coding = containsAny(text, [
    'build',
    'implement',
    'create app',
    'refactor',
    'fix bug',
    'write code',
    'codebase',
    'typescript',
    'javascript',
    'react',
    'next.js',
    'unit test',
    'run tests',
    'compile',
    'npm ',
    'pnpm ',
    'yarn ',
  ])
  if (coding) {
    return {
      intent: 'coding',
      confidence: 0.9,
      preferredTools: ['claude_code', 'codex_cli', 'opencode_cli', 'shell', 'files', 'edit_file'],
      preferredDelegates: delegateOrder,
      primaryUrl: url,
    }
  }

  const outreach = containsAny(text, [
    'send update',
    'message',
    'whatsapp',
    'telegram',
    'slack',
    'discord',
    'notify',
    'broadcast',
  ])
  if (outreach) {
    return {
      intent: 'outreach',
      confidence: 0.8,
      preferredTools: ['connector_message_tool', 'manage_connectors', 'manage_sessions'],
      preferredDelegates: delegateOrder,
      primaryUrl: url,
    }
  }

  const scheduling = containsAny(text, [
    'schedule',
    'every day',
    'every week',
    'cron',
    'recurring',
    'remind',
    'follow up tomorrow',
  ])
  if (scheduling) {
    return {
      intent: 'scheduling',
      confidence: 0.75,
      preferredTools: ['manage_schedules', 'manage_tasks'],
      preferredDelegates: delegateOrder,
      primaryUrl: url,
    }
  }

  const browsing = !!url && (
    containsAny(text, ['browser', 'click', 'fill form', 'log in', 'screenshot', 'navigate'])
    || enabledTools.includes('browser')
  )
  if (browsing) {
    return {
      intent: 'browsing',
      confidence: 0.7,
      preferredTools: ['browser', 'web_fetch'],
      preferredDelegates: delegateOrder,
      primaryUrl: url,
    }
  }

  const research = containsAny(text, [
    'research',
    'look up',
    'find out',
    'search for',
    'compare',
    'latest',
    'news',
    'wikipedia',
    'summarize this url',
    'analyze website',
  ]) || !!url
  if (research) {
    return {
      intent: 'research',
      confidence: 0.7,
      preferredTools: ['web_search', 'web_fetch', 'browser'],
      preferredDelegates: delegateOrder,
      primaryUrl: url,
    }
  }

  const memory = containsAny(text, ['remember', 'memory', 'recall', 'what do we know', 'notes'])
  if (memory) {
    return {
      intent: 'memory',
      confidence: 0.65,
      preferredTools: ['memory_tool'],
      preferredDelegates: delegateOrder,
      primaryUrl: url,
    }
  }

  return {
    intent: 'general',
    confidence: 0.5,
    preferredTools: [],
    preferredDelegates: delegateOrder,
    primaryUrl: url,
  }
}
