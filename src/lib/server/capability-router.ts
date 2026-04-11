import type { AppSettings } from '@/types'
import { dedup } from '@/lib/shared-utils'
import { getToolsForCapability, TOOL_CAPABILITY } from './tool-planning'
import type { MessageClassification } from '@/lib/server/chat-execution/message-classifier'

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

type DelegateTool = 'delegate_to_claude_code' | 'delegate_to_codex_cli' | 'delegate_to_opencode_cli' | 'delegate_to_gemini_cli' | 'delegate_to_copilot_cli' | 'delegate_to_cursor_cli' | 'delegate_to_qwen_code_cli'

function findFirstUrl(text: string): string | undefined {
  const m = text.match(/https?:\/\/[^\s<>"')]+/i)
  return m?.[0]
}

function dedupe(values: string[]): string[] {
  return dedup(values.filter(Boolean))
}

function preferredToolsForCapabilities(enabledExtensions: string[], capabilities: string[], fallback: string[] = []): string[] {
  const preferred = capabilities.flatMap((capability) => getToolsForCapability(enabledExtensions, capability))
  return dedupe(preferred.length > 0 ? preferred : fallback)
}

function normalizeDelegateOrder(value: unknown): DelegateTool[] {
  const fallback: DelegateTool[] = [
    'delegate_to_claude_code',
    'delegate_to_codex_cli',
    'delegate_to_opencode_cli',
    'delegate_to_gemini_cli',
    'delegate_to_copilot_cli',
    'delegate_to_cursor_cli',
    'delegate_to_qwen_code_cli',
  ]
  if (!Array.isArray(value) || !value.length) return fallback

  const mapped: DelegateTool[] = []
  for (const raw of value) {
    if (raw === 'claude') mapped.push('delegate_to_claude_code')
    else if (raw === 'codex') mapped.push('delegate_to_codex_cli')
    else if (raw === 'opencode') mapped.push('delegate_to_opencode_cli')
    else if (raw === 'gemini') mapped.push('delegate_to_gemini_cli')
    else if (raw === 'copilot') mapped.push('delegate_to_copilot_cli')
    else if (raw === 'cursor') mapped.push('delegate_to_cursor_cli')
    else if (raw === 'qwen') mapped.push('delegate_to_qwen_code_cli')
  }
  if (!mapped.length) return fallback
  const deduped = dedup(mapped)
  for (const tool of fallback) {
    if (!deduped.includes(tool)) deduped.push(tool)
  }
  return deduped
}

export function routeTaskIntent(
  message: string,
  enabledExtensions: string[],
  settings?: AppSettings | null,
  classification?: MessageClassification | null,
): CapabilityRoutingDecision {
  const url = findFirstUrl(message || '')
  const delegateOrder = normalizeDelegateOrder(settings?.autonomyPreferredDelegates)
  const intent = classification?.taskIntent || 'general'
  const confidence = classification?.confidence ?? 0
  const wantsVoiceDelivery = classification?.wantsVoiceDelivery === true
  const wantsScreenshots = classification?.wantsScreenshots === true
  const wantsOutboundDelivery = classification?.wantsOutboundDelivery === true

  if (intent === 'coding') {
    return {
      intent: 'coding',
      confidence,
      preferredTools: ['claude_code', 'codex_cli', 'opencode_cli', 'gemini_cli', 'cursor_cli', 'qwen_code_cli', 'shell', 'files', 'edit_file'],
      preferredDelegates: delegateOrder,
      primaryUrl: url,
    }
  }

  if (intent === 'outreach') {
    return {
      intent: 'outreach',
      confidence,
      preferredTools: preferredToolsForCapabilities(
        enabledExtensions,
        [
          ...(wantsVoiceDelivery ? [TOOL_CAPABILITY.deliveryVoiceNote] : []),
          ...(wantsScreenshots ? [TOOL_CAPABILITY.deliveryMedia] : []),
          ...(wantsOutboundDelivery || wantsVoiceDelivery ? [TOOL_CAPABILITY.deliveryMessage] : []),
          TOOL_CAPABILITY.deliveryMessage,
        ],
        ['connector_message_tool', 'manage_connectors', 'manage_sessions'],
      ),
      preferredDelegates: delegateOrder,
      primaryUrl: url,
    }
  }

  if (intent === 'scheduling') {
    return {
      intent: 'scheduling',
      confidence,
      preferredTools: ['manage_schedules', 'manage_tasks'],
      preferredDelegates: delegateOrder,
      primaryUrl: url,
    }
  }

  if (intent === 'browsing') {
    return {
      intent: 'browsing',
      confidence,
      preferredTools: preferredToolsForCapabilities(
        enabledExtensions,
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

  if (intent === 'research') {
    const preferred = preferredToolsForCapabilities(
      enabledExtensions,
      [
        TOOL_CAPABILITY.researchSearch,
        TOOL_CAPABILITY.researchFetch,
        ...(wantsScreenshots ? [TOOL_CAPABILITY.browserCapture] : []),
        ...(wantsVoiceDelivery ? [TOOL_CAPABILITY.deliveryVoiceNote] : []),
        ...(wantsOutboundDelivery ? [TOOL_CAPABILITY.deliveryMedia, TOOL_CAPABILITY.deliveryMessage] : []),
      ],
      ['web_search', 'web_fetch', 'browser'],
    )
    return {
      intent: 'research',
      confidence,
      preferredTools: preferred,
      preferredDelegates: delegateOrder,
      primaryUrl: url,
    }
  }

  return {
    intent: 'general',
    confidence,
    preferredTools: [],
    preferredDelegates: delegateOrder,
    primaryUrl: url,
  }
}
