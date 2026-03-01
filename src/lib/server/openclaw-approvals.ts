import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { resolveOpenClawWorkspace } from './openclaw-sync'

const APPROVAL_TIMEOUT_MS = 30_000

interface ApprovalRequest {
  toolName: string
  args: Record<string, unknown>
  socketPath?: string
}

interface ApprovalResponse {
  approved: boolean
  reason?: string
}

function resolveSocketPath(): string | null {
  try {
    const workspace = resolveOpenClawWorkspace()
    const socketPath = path.join(workspace, 'exec-approvals.sock')
    if (fs.existsSync(socketPath)) return socketPath
  } catch { /* workspace not found */ }
  return null
}

function resolveApprovalToken(): string | null {
  try {
    const workspace = resolveOpenClawWorkspace()
    const tokenPath = path.join(workspace, 'exec-approvals.json')
    if (!fs.existsSync(tokenPath)) return null
    const raw = JSON.parse(fs.readFileSync(tokenPath, 'utf8'))
    return typeof raw?.token === 'string' ? raw.token : null
  } catch {
    return null
  }
}

/**
 * Forward a tool approval request to OpenClaw's exec-approvals Unix socket.
 * Returns the approval decision, or null if the socket is unavailable.
 */
export async function forwardApprovalToOpenClaw(request: ApprovalRequest): Promise<ApprovalResponse | null> {
  const socketPath = request.socketPath || resolveSocketPath()
  if (!socketPath) return null

  const token = resolveApprovalToken()

  return new Promise<ApprovalResponse | null>((resolve) => {
    const socket = net.createConnection({ path: socketPath }, () => {
      const payload = JSON.stringify({
        type: 'approval_request',
        toolName: request.toolName,
        args: request.args,
        token,
        timestamp: Date.now(),
      })
      socket.write(payload + '\n')
    })

    let data = ''
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(null) // Timeout — fall through to SwarmClaw UI
    }, APPROVAL_TIMEOUT_MS)

    socket.on('data', (chunk) => {
      data += chunk.toString()
      // Try to parse complete JSON response
      try {
        const response = JSON.parse(data.trim())
        clearTimeout(timer)
        socket.destroy()
        resolve({
          approved: response.approved === true,
          reason: typeof response.reason === 'string' ? response.reason : undefined,
        })
      } catch {
        // Incomplete data, wait for more
      }
    })

    socket.on('error', () => {
      clearTimeout(timer)
      resolve(null) // Socket error — fall through
    })

    socket.on('close', () => {
      clearTimeout(timer)
      // If we haven't resolved yet, try to parse what we have
      if (data.trim()) {
        try {
          const response = JSON.parse(data.trim())
          resolve({
            approved: response.approved === true,
            reason: typeof response.reason === 'string' ? response.reason : undefined,
          })
          return
        } catch { /* fall through */ }
      }
      resolve(null)
    })
  })
}
