import type { PluginHooks, PluginToolDef } from '@/types'
import { canonicalizePluginId, expandPluginIds } from './tool-aliases'
import { dedup } from '@/lib/shared-utils'

type ApprovalGuidanceHook = NonNullable<PluginHooks['getApprovalGuidance']>

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeApprovalGuidanceLines(
  value: string | string[] | null | undefined,
): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? [trimmed] : []
  }
  if (!Array.isArray(value)) return []
  return value
    .map((line) => (typeof line === 'string' ? line.trim() : ''))
    .filter(Boolean)
}

function dedupeApprovalGuidanceLines(lines: string[]): string[] {
  return dedup(lines.map((line) => line.trim()).filter(Boolean))
}

function formatApprovalToolLabel(toolNames: string[]): string {
  const uniqueNames = dedup(toolNames.map((name) => name.trim()).filter(Boolean))
  if (uniqueNames.length === 0) return 'its tools'
  if (uniqueNames.length === 1) return `\`${uniqueNames[0]}\``
  if (uniqueNames.length === 2) return `\`${uniqueNames[0]}\` and \`${uniqueNames[1]}\``
  return `${uniqueNames.slice(0, -1).map((name) => `\`${name}\``).join(', ')}, and \`${uniqueNames.at(-1)}\``
}

function buildDefaultPluginApprovalGuidance(params: {
  pluginId: string
  pluginName: string
  tools: PluginToolDef[]
}): ApprovalGuidanceHook {
  const toolNames = params.tools
    .map((tool) => (typeof tool?.name === 'string' ? tool.name.trim() : ''))
    .filter(Boolean)
  const toolLabel = formatApprovalToolLabel(toolNames)
  const matchIds = new Set(
    dedupeApprovalGuidanceLines([
      params.pluginId,
      ...toolNames,
      ...expandPluginIds([params.pluginId]),
      ...toolNames.flatMap((toolName) => expandPluginIds([toolName])),
    ]).map((value) => canonicalizePluginId(value) || value.toLowerCase()),
  )

  return ({ approval, phase, approved }) => {
    if (approval.category !== 'tool_access') return null
    const requestedIds = [
      trimString(approval.data.pluginId),
      trimString(approval.data.toolId),
      trimString(approval.data.toolName),
    ].filter(Boolean)
    const matchesPlugin = requestedIds.some((value) => {
      const candidates = [value, ...expandPluginIds([value])]
      return candidates.some((candidate) => matchIds.has(canonicalizePluginId(candidate) || candidate.toLowerCase()))
    })
    if (!matchesPlugin) return null

    if (phase === 'connector_reminder') {
      return `Approving this lets the agent use ${toolLabel} from ${params.pluginName}.`
    }
    if (approved === true) {
      return [
        `Access to ${params.pluginName} is approved. Continue with ${toolLabel} on the next turn.`,
        'Do not request the same access again in prose once it has been approved.',
      ]
    }
    if (approved === false) {
      return `Do not request access to ${params.pluginName} again unless the task or required capability materially changes.`
    }
    return [
      `If access to ${params.pluginName} is granted, continue with ${toolLabel} on the next turn.`,
      'Do not ask for the same access again in prose while this approval is pending.',
    ]
  }
}

function composeApprovalGuidance(
  defaultHook: ApprovalGuidanceHook,
  customHook?: PluginHooks['getApprovalGuidance'],
): ApprovalGuidanceHook {
  return (ctx) => {
    const combined = dedupeApprovalGuidanceLines([
      ...normalizeApprovalGuidanceLines(defaultHook(ctx)),
      ...normalizeApprovalGuidanceLines(customHook?.(ctx)),
    ])
    return combined.length > 0 ? combined : null
  }
}

export function buildPluginHooks(
  pluginId: string,
  pluginName: string,
  hooks: PluginHooks | undefined,
  tools: PluginToolDef[] | undefined,
): PluginHooks {
  const nextHooks: PluginHooks = { ...(hooks || {}) }
  nextHooks.getApprovalGuidance = composeApprovalGuidance(
    buildDefaultPluginApprovalGuidance({
      pluginId,
      pluginName,
      tools: tools || [],
    }),
    hooks?.getApprovalGuidance,
  )
  return nextHooks
}
