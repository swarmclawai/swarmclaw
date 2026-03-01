import { ensureGatewayConnected } from './openclaw-gateway'

export interface ConfigIssue {
  id: string
  severity: 'warning' | 'error'
  title: string
  description: string
  repairAction?: string
}

/** Fetch gateway config and detect common issues */
export async function detectConfigIssues(): Promise<ConfigIssue[]> {
  const gw = await ensureGatewayConnected()
  if (!gw) return [{ id: 'no-connection', severity: 'error', title: 'Not Connected', description: 'Gateway is not connected.' }]

  let config: Record<string, unknown>
  try {
    config = (await gw.rpc('config.get')) as Record<string, unknown> ?? {}
  } catch {
    return [{ id: 'config-fetch-failed', severity: 'error', title: 'Config Fetch Failed', description: 'Could not retrieve gateway configuration.' }]
  }

  const issues: ConfigIssue[] = []

  // Check sandbox env allowlist
  const agentsDefaults = config.agents as Record<string, unknown> | undefined
  const sandbox = (agentsDefaults?.defaults as Record<string, unknown>)?.sandbox as Record<string, unknown> | undefined
  const docker = sandbox?.docker as Record<string, unknown> | undefined
  const envArr = docker?.env as string[] | undefined
  if (!envArr || envArr.length === 0) {
    issues.push({
      id: 'empty-sandbox-env',
      severity: 'warning',
      title: 'Empty Sandbox Env',
      description: 'No environment variables are allowed in the sandbox. Agents may lack API access.',
      repairAction: 'sandbox-env-defaults',
    })
  }

  // Check model defaults
  const models = config.models as Record<string, unknown> | undefined
  const defaultModel = models?.default as string | undefined
  if (!defaultModel) {
    issues.push({
      id: 'no-default-model',
      severity: 'warning',
      title: 'No Default Model',
      description: 'No default model is configured. Agents will need explicit model assignment.',
      repairAction: 'set-default-model',
    })
  }

  // Check reload mode
  const reloadMode = config.reloadMode as string | undefined
  if (reloadMode === 'full') {
    issues.push({
      id: 'full-reload-mode',
      severity: 'warning',
      title: 'Full Reload Mode',
      description: 'Gateway is in full reload mode. This restarts all agents on config change, which may disrupt running sessions.',
    })
  }

  return issues
}

/** Attempt to repair a specific config issue with hash-based retry */
export async function repairConfigIssue(issueId: string): Promise<{ ok: boolean; error?: string }> {
  const gw = await ensureGatewayConnected()
  if (!gw) return { ok: false, error: 'Gateway not connected' }

  const MAX_RETRIES = 3
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const config = (await gw.rpc('config.get')) as Record<string, unknown> & { _hash?: string } ?? {}
      const baseHash = config._hash as string | undefined

      switch (issueId) {
        case 'sandbox-env-defaults': {
          // Set common env vars as defaults
          const defaultEnvVars = ['${OPENAI_API_KEY}', '${ANTHROPIC_API_KEY}']
          await gw.rpc('config.set', {
            path: 'agents.defaults.sandbox.docker.env',
            value: defaultEnvVars,
            ...(baseHash ? { baseHash } : {}),
          })
          return { ok: true }
        }
        case 'set-default-model': {
          await gw.rpc('config.set', {
            path: 'models.default',
            value: 'claude-sonnet-4-20250514',
            ...(baseHash ? { baseHash } : {}),
          })
          return { ok: true }
        }
        default:
          return { ok: false, error: `Unknown issue: ${issueId}` }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('conflict') && attempt < MAX_RETRIES - 1) continue
      return { ok: false, error: msg }
    }
  }
  return { ok: false, error: 'Max retries exceeded' }
}
