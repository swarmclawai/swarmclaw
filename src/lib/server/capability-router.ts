import type { AppSettings } from '@/types'
import { getToolsForCapability, matchToolCapabilitiesForMessage, TOOL_CAPABILITY } from './tool-planning'

export type TaskIntent =
  | 'coding'
  | 'research'
  | 'browsing'
  | 'outreach'
  | 'scheduling'
  | 'general'

export interface CapabilityRoutingDecision {
  intent: TaskIntent
  confidence: number
  preferredTools: string[]
  preferredDelegates: DelegateTool[]
  primaryUrl?: string
}

type DelegateTool = 'delegate_to_claude_code' | 'delegate_to_codex_cli' | 'delegate_to_opencode_cli' | 'delegate_to_gemini_cli'

function findFirstUrl(text: string): string | undefined {
  const m = text.match(/https?:\/\/[^\s<>"')]+/i)
  return m?.[0]
}

function containsAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term))
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

function preferredToolsForCapabilities(enabledPlugins: string[], capabilities: string[], fallback: string[] = []): string[] {
  const preferred = capabilities.flatMap((capability) => getToolsForCapability(enabledPlugins, capability))
  return dedupe(preferred.length > 0 ? preferred : fallback)
}

function normalizeDelegateOrder(value: unknown): DelegateTool[] {
  const fallback: DelegateTool[] = [
    'delegate_to_claude_code',
    'delegate_to_codex_cli',
    'delegate_to_opencode_cli',
    'delegate_to_gemini_cli',
  ]
  if (!Array.isArray(value) || !value.length) return fallback

  const mapped: DelegateTool[] = []
  for (const raw of value) {
    if (raw === 'claude') mapped.push('delegate_to_claude_code')
    else if (raw === 'codex') mapped.push('delegate_to_codex_cli')
    else if (raw === 'opencode') mapped.push('delegate_to_opencode_cli')
    else if (raw === 'gemini') mapped.push('delegate_to_gemini_cli')
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
  enabledPlugins: string[],
  settings?: AppSettings | null,
): CapabilityRoutingDecision {
  const text = (message || '').toLowerCase()
  const url = findFirstUrl(message || '')
  const delegateOrder = normalizeDelegateOrder(settings?.autonomyPreferredDelegates)
  const matchedCapabilities = matchToolCapabilitiesForMessage(enabledPlugins, message)
  const wantsVoiceNote = matchedCapabilities.has(TOOL_CAPABILITY.deliveryVoiceNote)
  const wantsScreenshots = matchedCapabilities.has(TOOL_CAPABILITY.browserCapture)
  const wantsMediaDelivery = matchedCapabilities.has(TOOL_CAPABILITY.deliveryMedia)
  const wantsChannelDelivery = matchedCapabilities.has(TOOL_CAPABILITY.deliveryMessage)
  const researchLike = matchedCapabilities.has(TOOL_CAPABILITY.researchSearch)
    || matchedCapabilities.has(TOOL_CAPABILITY.researchFetch)
    || !!url

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
  ]) || (!researchLike && (wantsVoiceNote || wantsMediaDelivery || wantsChannelDelivery))
  if (outreach) {
    return {
      intent: 'outreach',
      confidence: 0.8,
      preferredTools: preferredToolsForCapabilities(
        enabledPlugins,
        [
          TOOL_CAPABILITY.deliveryVoiceNote,
          TOOL_CAPABILITY.deliveryMedia,
          TOOL_CAPABILITY.deliveryMessage,
        ],
        ['connector_message_tool', 'manage_connectors', 'manage_sessions'],
      ),
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
    matchedCapabilities.has(TOOL_CAPABILITY.browserNavigate)
    || matchedCapabilities.has(TOOL_CAPABILITY.browserCapture)
    || getToolsForCapability(enabledPlugins, TOOL_CAPABILITY.browserNavigate).length > 0
    || getToolsForCapability(enabledPlugins, TOOL_CAPABILITY.browserCapture).length > 0
  )
  if (browsing) {
    return {
      intent: 'browsing',
      confidence: 0.7,
      preferredTools: preferredToolsForCapabilities(
        enabledPlugins,
        [
          TOOL_CAPABILITY.browserCapture,
          TOOL_CAPABILITY.browserNavigate,
          TOOL_CAPABILITY.researchFetch,
        ],
        ['browser', 'web_fetch'],
      ),
      preferredDelegates: delegateOrder,
      primaryUrl: url,
    }
  }

  const research = researchLike
  if (research) {
    const preferred = preferredToolsForCapabilities(
      enabledPlugins,
      [
        TOOL_CAPABILITY.researchSearch,
        TOOL_CAPABILITY.researchFetch,
        ...(wantsScreenshots ? [TOOL_CAPABILITY.browserCapture] : []),
        ...(wantsVoiceNote ? [TOOL_CAPABILITY.deliveryVoiceNote] : []),
        ...(wantsMediaDelivery || wantsChannelDelivery ? [TOOL_CAPABILITY.deliveryMedia, TOOL_CAPABILITY.deliveryMessage] : []),
      ],
      ['web_search', 'web_fetch', 'browser'],
    )
    return {
      intent: 'research',
      confidence: 0.7,
      preferredTools: preferred,
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
