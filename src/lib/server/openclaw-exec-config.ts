import type { ExecApprovalConfig, ExecApprovalSnapshot } from '@/types'
import { ensureGatewayConnected } from './openclaw-gateway'

const DEFAULT_CONFIG: ExecApprovalConfig = {
  security: 'deny',
  askMode: 'off',
  patterns: [],
}

/** Fetch the gateway's global exec approval config. */
export async function getExecConfig(agentId?: string): Promise<ExecApprovalSnapshot> {
  void agentId
  const gw = await ensureGatewayConnected()
  if (!gw) throw new Error('Gateway not connected')

  const result = await gw.rpc('exec.approvals.get', {}) as ExecApprovalSnapshot | undefined
  if (!result) {
    return { path: '', exists: false, hash: '', file: { ...DEFAULT_CONFIG } }
  }
  return result
}

/** Save exec approval config with hash-based conflict retry (up to 3 attempts) */
export async function setExecConfig(
  agentId: string,
  config: ExecApprovalConfig,
  baseHash: string,
): Promise<{ ok: boolean; hash: string }> {
  void agentId
  const gw = await ensureGatewayConnected()
  if (!gw) throw new Error('Gateway not connected')

  let currentHash = baseHash
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await gw.rpc('exec.approvals.set', {
        file: config,
        baseHash: currentHash,
      }) as { hash?: string } | undefined
      return { ok: true, hash: result?.hash ?? '' }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('conflict') && attempt < 2) {
        // Re-fetch to get fresh hash
        const fresh = await getExecConfig()
        currentHash = fresh.hash
        continue
      }
      throw err
    }
  }
  throw new Error('Failed after 3 conflict retries')
}
