import type { ApprovalRequest } from '@/types'

function truncate(value: string, max = 320): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}... (${value.length} chars)`
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]'
  if (typeof value === 'string') return truncate(value)
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((entry) => sanitizeValue(entry, depth + 1))
  }
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
    out[k] = sanitizeValue(v, depth + 1)
  }
  return out
}

function dataObject(approval: ApprovalRequest): Record<string, unknown> {
  return approval.data && typeof approval.data === 'object' ? approval.data : {}
}

export function getApprovalPluginId(approval: ApprovalRequest): string | null {
  const data = dataObject(approval)
  const toolId = typeof data.toolId === 'string' ? data.toolId.trim() : ''
  if (toolId) return toolId
  const pluginId = typeof data.pluginId === 'string' ? data.pluginId.trim() : ''
  return pluginId || null
}

export function getApprovalTitle(approval: ApprovalRequest): string {
  if (approval.category === 'tool_access') {
    const pluginId = getApprovalPluginId(approval)
    return pluginId ? `Enable Plugin: ${pluginId}` : 'Enable Plugin'
  }
  return approval.title || 'Approval Request'
}

export function getApprovalPayload(approval: ApprovalRequest): Record<string, unknown> {
  const data = dataObject(approval)

  if (approval.category === 'tool_access') {
    const pluginId = getApprovalPluginId(approval)
    if (pluginId) return { pluginId }
    return { warning: 'Missing plugin/tool identifier', raw: sanitizeValue(data) }
  }

  if (approval.category === 'plugin_scaffold') {
    const filename = typeof data.filename === 'string' ? data.filename : null
    const code = typeof data.code === 'string' ? data.code : ''
    return {
      filename,
      codeLength: code.length,
      codePreview: code ? truncate(code, 260) : '',
    }
  }

  return (sanitizeValue(data) || {}) as Record<string, unknown>
}
