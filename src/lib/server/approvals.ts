import fs from 'fs'
import path from 'path'
import { genId } from '@/lib/id'
import { loadApprovals, upsertApproval, loadSessions, saveSessions } from './storage'
import type { ApprovalRequest, ApprovalCategory } from '@/types'
import { notify } from './ws-hub'
import { DATA_DIR } from './data-dir'
import { log } from './logger'

function getApprovalTargetId(data: Record<string, unknown>): string | null {
  const toolId = typeof data.toolId === 'string' ? data.toolId.trim() : ''
  if (toolId) return toolId
  const pluginId = typeof data.pluginId === 'string' ? data.pluginId.trim() : ''
  return pluginId || null
}

export function requestApproval(params: {
  category: ApprovalCategory
  title: string
  description?: string
  data: Record<string, unknown>
  agentId?: string | null
  sessionId?: string | null
  taskId?: string | null
}): ApprovalRequest {
  const targetId = getApprovalTargetId(params.data)
  if (params.category === 'tool_access' && !targetId) {
    throw new Error('tool_access approvals require a toolId or pluginId')
  }

  const normalizedData = { ...params.data }
  if (params.category === 'tool_access' && targetId) {
    normalizedData.toolId = targetId
    normalizedData.pluginId = targetId
  }

  const id = genId(8)
  const now = Date.now()
  const request: ApprovalRequest = {
    id,
    ...params,
    title: params.category === 'tool_access' && targetId ? `Enable Plugin: ${targetId}` : params.title,
    data: normalizedData,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  }

  upsertApproval(id, request)

  notify('approvals')
  return request
}


export async function submitDecision(id: string, approved: boolean): Promise<void> {
  const approvals = loadApprovals() as Record<string, ApprovalRequest>
  const request = approvals[id]
  if (!request) throw new Error('Approval request not found')
  
  request.status = approved ? 'approved' : 'rejected'
  request.updatedAt = Date.now()
  upsertApproval(id, request)
  
  // Handle specific side effects based on category
  if (approved) {
    if (request.category === 'tool_access' && request.sessionId) {
      const sessions = loadSessions()
      const session = sessions[request.sessionId]
      if (session) {
        const toolId = getApprovalTargetId(request.data)
        const currentTools = session.plugins || []
        if (toolId && !currentTools.includes(toolId)) {
          session.plugins = [...currentTools, toolId]
          saveSessions(sessions)
        }
      }
    }

    if (request.category === 'plugin_scaffold') {
      const filename = typeof request.data.filename === 'string' ? request.data.filename : ''
      const code = typeof request.data.code === 'string' ? request.data.code : ''
      if (filename && code) {
        const pluginsDir = path.join(DATA_DIR, 'plugins')
        if (!fs.existsSync(pluginsDir)) fs.mkdirSync(pluginsDir, { recursive: true })
        fs.writeFileSync(path.join(pluginsDir, filename), code, 'utf8')
        const { getPluginManager } = await import('./plugins')
        getPluginManager().reload()

        // Store creator agent metadata
        const createdByAgentId = typeof request.data.createdByAgentId === 'string' ? request.data.createdByAgentId : request.agentId
        if (createdByAgentId) {
          getPluginManager().setMeta(filename, { createdByAgentId })
        }
        log.info('approvals', `Plugin scaffolded: ${filename}`)

        // Auto-enable the new plugin for the creating agent's session
        if (request.sessionId) {
          const sessions = loadSessions()
          const session = sessions[request.sessionId]
          if (session) {
            const currentTools = session.plugins || []
            if (!currentTools.includes(filename)) {
              session.plugins = [...currentTools, filename]
              saveSessions(sessions)
            }
          }
        }
        notify('plugins')
      }
    }

    if (request.category === 'plugin_install') {
      const url = typeof request.data.url === 'string' ? request.data.url : ''
      if (url) {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
          if (res.ok) {
            const code = await res.text()
            const pluginId = typeof request.data.pluginId === 'string' ? request.data.pluginId : ''
            const safeName = (pluginId || url.split('/').pop() || 'plugin').replace(/[^a-zA-Z0-9._-]/g, '_')
            const filename = safeName.endsWith('.js') ? safeName : `${safeName}.js`
            const pluginsDir = path.join(DATA_DIR, 'plugins')
            if (!fs.existsSync(pluginsDir)) fs.mkdirSync(pluginsDir, { recursive: true })
            fs.writeFileSync(path.join(pluginsDir, filename), code, 'utf8')
            const { getPluginManager } = await import('./plugins')
            getPluginManager().reload()
            log.info('approvals', `Plugin installed from URL: ${filename}`)
            notify('plugins')
          }
        } catch (err: unknown) {
          log.error('approvals', 'Plugin install failed after approval', {
            url,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }
  }

  notify('approvals')
  if (request.sessionId) notify(`session:${request.sessionId}`)
}

export function listPendingApprovals(): ApprovalRequest[] {
  const approvals = loadApprovals() as Record<string, ApprovalRequest>
  return Object.values(approvals)
    .filter(a => a.status === 'pending')
    .sort((a, b) => b.updatedAt - a.updatedAt)
}
