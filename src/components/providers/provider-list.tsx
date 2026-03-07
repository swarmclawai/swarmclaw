'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { OpenClawDeployPanel } from '@/components/openclaw/openclaw-deploy-panel'
import { useAppStore } from '@/stores/use-app-store'
import { useWs } from '@/hooks/use-ws'
import { api } from '@/lib/api-client'
import type { Credential, GatewayProfile } from '@/types'

interface OpenClawDeployDraft {
  endpoint: string
  token?: string
  name?: string
  notes?: string
  deployment?: GatewayProfile['deployment']
}

function formatRuntimeTimestamp(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 'Never'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(value)
}

export function ProviderList({ inSidebar }: { inSidebar?: boolean }) {
  const providers = useAppStore((s) => s.providers)
  const providerConfigs = useAppStore((s) => s.providerConfigs)
  const loadProviders = useAppStore((s) => s.loadProviders)
  const loadProviderConfigs = useAppStore((s) => s.loadProviderConfigs)
  const gatewayProfiles = useAppStore((s) => s.gatewayProfiles)
  const loadGatewayProfiles = useAppStore((s) => s.loadGatewayProfiles)
  const externalAgents = useAppStore((s) => s.externalAgents)
  const loadExternalAgents = useAppStore((s) => s.loadExternalAgents)
  const credentials = useAppStore((s) => s.credentials)
  const loadCredentials = useAppStore((s) => s.loadCredentials)
  const setProviderSheetOpen = useAppStore((s) => s.setProviderSheetOpen)
  const setEditingProviderId = useAppStore((s) => s.setEditingProviderId)
  const setGatewaySheetOpen = useAppStore((s) => s.setGatewaySheetOpen)
  const setEditingGatewayId = useAppStore((s) => s.setEditingGatewayId)
  const [loaded, setLoaded] = useState(false)
  const [deployDraft, setDeployDraft] = useState<OpenClawDeployDraft | null>(null)
  const [savingDeploy, setSavingDeploy] = useState(false)

  const refresh = useCallback(async () => {
    await Promise.all([loadProviders(), loadProviderConfigs(), loadGatewayProfiles(), loadExternalAgents(), loadCredentials()])
    setLoaded(true)
  }, [loadProviders, loadProviderConfigs, loadGatewayProfiles, loadExternalAgents, loadCredentials])

  useEffect(() => { void refresh() }, [refresh])
  useWs('providers', loadProviders, 20_000)
  useWs('gateways', loadGatewayProfiles, 20_000)
  useWs('external_agents', loadExternalAgents, 20_000)

  const handleEdit = (id: string) => {
    setEditingProviderId(id)
    setProviderSheetOpen(true)
  }

  const handleToggle = async (e: React.MouseEvent, id: string, currentEnabled: boolean) => {
    e.stopPropagation()
    await api('PUT', `/providers/${id}`, { isEnabled: !currentEnabled })
    await loadProviderConfigs()
  }

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    await api('DELETE', `/providers/${id}`)
    await loadProviderConfigs()
  }

  const handleEditGateway = (id: string | null) => {
    setEditingGatewayId(id)
    setGatewaySheetOpen(true)
  }

  const handleDeleteGateway = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    await api('DELETE', `/gateways/${id}`)
    await loadGatewayProfiles()
  }

  const handleHealthCheckGateway = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    await api('GET', `/gateways/${id}/health`)
    await loadGatewayProfiles()
  }

  const handleDeployApply = (patch: { endpoint?: string; token?: string; name?: string; notes?: string; deployment?: GatewayProfile['deployment'] | Record<string, unknown> | null }) => {
    if (!patch.endpoint) return
    setDeployDraft({
      endpoint: patch.endpoint,
      token: patch.token,
      name: patch.name,
      notes: patch.notes,
      deployment: (patch.deployment as GatewayProfile['deployment']) || null,
    })
  }

  const handleSavePreparedGateway = async () => {
    if (!deployDraft?.endpoint) return
    setSavingDeploy(true)
    try {
      let nextCredentialId: string | null = null
      if (deployDraft.token?.trim()) {
        const credential = await api<Credential>('POST', '/credentials', {
          provider: 'openclaw',
          name: `${deployDraft.name || 'OpenClaw Gateway'} token`,
          apiKey: deployDraft.token.trim(),
        })
        nextCredentialId = credential.id
      }

      const existing = gatewayProfiles.find((gateway) => gateway.endpoint === deployDraft.endpoint) || null
      const nextTags = Array.from(new Set([
        ...(existing?.tags || []),
        'managed-deploy',
        ...(deployDraft.deployment?.useCase ? [deployDraft.deployment.useCase] : []),
        ...(deployDraft.deployment?.exposure ? [deployDraft.deployment.exposure] : []),
      ]))
      const verify = await api<{
        ok: boolean
        verify?: {
          ok: boolean
          error?: string
          hint?: string
          models?: string[]
        }
      }>('POST', '/openclaw/deploy', {
        action: 'verify',
        endpoint: deployDraft.endpoint,
        token: deployDraft.token?.trim() || undefined,
      }).catch(() => ({ ok: false, verify: undefined as undefined }))
      const verifiedOk = verify.verify?.ok === true
      const payload = {
        name: deployDraft.name || existing?.name || 'OpenClaw Gateway',
        endpoint: deployDraft.endpoint,
        credentialId: nextCredentialId || existing?.credentialId || null,
        notes: deployDraft.notes || existing?.notes || 'Managed OpenClaw deploy prepared from SwarmClaw.',
        tags: nextTags,
        status: verifiedOk ? 'healthy' : (existing?.status || 'pending'),
        deployment: {
          ...(existing?.deployment || {}),
          ...(deployDraft.deployment || {}),
          managedBy: 'swarmclaw',
          lastVerifiedAt: verify.verify ? Date.now() : (existing?.deployment?.lastVerifiedAt || null),
          lastVerifiedOk: verify.verify ? verifiedOk : (existing?.deployment?.lastVerifiedOk ?? null),
          lastVerifiedMessage: verify.verify
            ? (verifiedOk
              ? `Verified during save with ${verify.verify.models?.length || 0} model${(verify.verify.models?.length || 0) === 1 ? '' : 's'}.`
              : (verify.verify.error || verify.verify.hint || 'Verification failed.'))
            : (existing?.deployment?.lastVerifiedMessage || null),
        },
        isDefault: existing?.isDefault === true || gatewayProfiles.length === 0,
      }

      if (existing) {
        await api('PUT', `/gateways/${existing.id}`, payload)
      } else {
        await api('POST', '/gateways', payload)
      }

      await Promise.all([loadGatewayProfiles(), loadCredentials()])
      setDeployDraft(null)
      toast.success(existing ? 'Gateway profile updated' : 'Gateway profile saved')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to save prepared gateway')
    } finally {
      setSavingDeploy(false)
    }
  }

  const handleCloneGateway = async (e: React.MouseEvent, gateway: GatewayProfile) => {
    e.stopPropagation()
    try {
      await api('POST', '/gateways', {
        name: `${gateway.name} Copy`,
        endpoint: gateway.endpoint,
        credentialId: gateway.credentialId || null,
        notes: gateway.notes || null,
        tags: gateway.tags || [],
        deployment: gateway.deployment || null,
        stats: gateway.stats || null,
        isDefault: false,
      })
      await loadGatewayProfiles()
      toast.success('Gateway cloned')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to clone gateway')
    }
  }

  const handleRuntimeAction = async (
    e: React.MouseEvent,
    runtimeId: string,
    action: 'activate' | 'drain' | 'cordon' | 'restart',
  ) => {
    e.stopPropagation()
    try {
      await api('PUT', `/external-agents/${runtimeId}`, { action })
      await loadExternalAgents()
      const actionLabel = action === 'activate'
        ? 'Runtime activated'
        : action === 'drain'
          ? 'Runtime draining'
          : action === 'cordon'
            ? 'Runtime cordoned'
            : 'Restart requested'
      toast.success(actionLabel)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Runtime action failed')
    }
  }

  // Merge built-in providers with custom configs
  const builtinItems = providers.map((p) => ({
    id: p.id,
    name: p.name,
    type: 'builtin' as const,
    models: p.models,
    requiresApiKey: p.requiresApiKey,
    isEnabled: true,
    isConnected: !p.requiresApiKey || Object.values(credentials).some((c) => c.provider === p.id),
  }))

  const customItems = providerConfigs.map((c) => ({
    id: c.id,
    name: c.name,
    type: 'custom' as const,
    models: c.models,
    requiresApiKey: c.requiresApiKey,
    isEnabled: c.isEnabled,
    isConnected: !c.requiresApiKey || !!c.credentialId,
  }))

  const allItems = [...builtinItems, ...customItems]
  const gatewayNameById = new Map(gatewayProfiles.map((gateway) => [gateway.id, gateway.name]))
  const runtimeHealthByGateway = externalAgents.reduce<Record<string, { total: number; active: number; lastHeartbeatAt: number | null }>>((acc, runtime) => {
    if (!runtime.gatewayProfileId) return acc
    const current = acc[runtime.gatewayProfileId] || { total: 0, active: 0, lastHeartbeatAt: null }
    current.total += 1
    if (runtime.status === 'online' || runtime.status === 'idle') current.active += 1
    if (typeof runtime.lastSeenAt === 'number' && (!current.lastHeartbeatAt || runtime.lastSeenAt > current.lastHeartbeatAt)) {
      current.lastHeartbeatAt = runtime.lastSeenAt
    }
    acc[runtime.gatewayProfileId] = current
    return acc
  }, {})

  if (!loaded) {
    return (
      <div className={`flex-1 flex items-center justify-center ${inSidebar ? 'px-3 pb-4' : 'px-5'}`}>
        <p className="text-[13px] text-text-3">Loading providers...</p>
      </div>
    )
  }

  return (
    <div className={`flex-1 overflow-y-auto ${inSidebar ? 'px-3 pb-4' : 'px-5 pb-6'}`}>
      <div className="mb-4 flex items-center justify-between">
        <div className="text-[12px] font-700 uppercase tracking-[0.08em] text-text-3/60">Model Providers</div>
        {!inSidebar && (
          <button
            type="button"
            onClick={() => handleEditGateway(null)}
            className="px-3 py-1.5 rounded-[8px] border border-white/[0.08] bg-transparent text-[11px] font-700 text-text-2 hover:bg-white/[0.04] transition-all cursor-pointer"
          >
            + Gateway
          </button>
        )}
      </div>
      <div className={inSidebar ? 'space-y-2' : 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3'}>
        {allItems.map((item, idx) => (
          <div
            key={item.id}
            role="button"
            tabIndex={0}
            onClick={() => handleEdit(item.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                handleEdit(item.id)
              }
            }}
            className="w-full text-left p-4 rounded-[14px] border transition-all duration-200
              cursor-pointer hover:bg-white/[0.02] bg-surface border-white/[0.06] hover:border-white/[0.12] hover:scale-[1.01]"
            style={{
              animation: 'spring-in 0.5s var(--ease-spring) both',
              animationDelay: `${idx * 0.05}s`
            }}
          >
            <div className="flex items-center justify-between mb-1.5">
              <span className="font-display text-[14px] font-600 text-text truncate">{item.name}</span>
              <div className="flex items-center gap-2 shrink-0">
                <span className={`text-[10px] font-600 px-2 py-0.5 rounded-[5px] uppercase tracking-wider
                  ${item.type === 'builtin' ? 'bg-white/[0.04] text-text-3' : 'bg-accent-bright/10 text-[#6366F1]'}`}>
                  {item.type === 'builtin' ? 'Built-in' : 'Custom'}
                </span>
                {!inSidebar && item.type === 'custom' && (
                  <>
                    <div
                      onClick={(e) => handleToggle(e, item.id, item.isEnabled)}
                      className={`w-9 h-5 rounded-full transition-all relative cursor-pointer shrink-0
                        ${item.isEnabled ? 'bg-accent-bright' : 'bg-white/[0.08]'}`}
                    >
                      <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all
                        ${item.isEnabled ? 'left-[18px]' : 'left-0.5'}`}
                        style={item.isEnabled ? { animation: 'spring-in 0.3s var(--ease-spring)' } : undefined}
                      />
                    </div>
                    <button
                      onClick={(e) => handleDelete(e, item.id)}
                      className="text-text-3/40 hover:text-red-400 transition-colors p-0.5"
                      title="Delete provider"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  </>
                )}
                <span className={`w-2 h-2 rounded-full ${item.isConnected ? 'bg-emerald-400' : 'bg-white/10'}`}
                  style={item.isConnected ? { animation: 'pulse-subtle 2s infinite' } : undefined} />
              </div>
            </div>
            <div className="text-[12px] text-text-3/60 font-mono truncate">
              {!inSidebar ? item.models.join(', ') : (
                <>
                  {item.models.slice(0, 3).join(', ')}
                  {item.models.length > 3 && ` +${item.models.length - 3}`}
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-8 mb-4 flex items-center justify-between">
        <div className="text-[12px] font-700 uppercase tracking-[0.08em] text-text-3/60">OpenClaw Gateways</div>
        {!inSidebar && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => handleEditGateway(null)}
              className="px-3 py-1.5 rounded-[8px] border border-white/[0.08] bg-transparent text-[11px] font-700 text-text-2 hover:bg-white/[0.04] transition-all cursor-pointer"
            >
              + New Gateway
            </button>
          </div>
        )}
      </div>
      {!inSidebar && (
        <div className="mb-4 rounded-[16px] border border-white/[0.06] bg-white/[0.02] p-4">
          <OpenClawDeployPanel
            compact
            title="Deploy OpenClaw Control Planes"
            description="Use official OpenClaw sources only. Start a local control plane on this machine, or generate a pre-configured remote bundle for Docker VPS hosts like Hetzner, DigitalOcean, Vultr, Linode, Lightsail, plus Render, Fly.io, and Railway."
            onApply={handleDeployApply}
          />
          {deployDraft?.endpoint && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-emerald-500/20 bg-emerald-500/[0.05] px-4 py-3">
              <div>
                <div className="text-[13px] font-700 text-emerald-300">Prepared gateway profile</div>
                <div className="mt-1 text-[12px] text-text-3">
                  {deployDraft.name || 'OpenClaw Gateway'} · <code className="text-text-2">{deployDraft.endpoint}</code>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void handleSavePreparedGateway()}
                  disabled={savingDeploy}
                  className="rounded-[10px] bg-accent-bright px-3.5 py-2 text-[12px] font-700 text-white border-none cursor-pointer hover:brightness-110 transition-all disabled:opacity-40"
                >
                  {savingDeploy ? 'Saving…' : 'Save Prepared Gateway'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      <div className={inSidebar ? 'space-y-2' : 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3'}>
        {gatewayProfiles.map((gateway, idx) => (
          (() => {
            const runtimeStats = runtimeHealthByGateway[gateway.id] || { total: 0, active: 0, lastHeartbeatAt: null }
            const deployment = gateway.deployment || null
            const stats = gateway.stats || null
            return (
          <div
            key={gateway.id}
            role="button"
            tabIndex={0}
            onClick={() => handleEditGateway(gateway.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                handleEditGateway(gateway.id)
              }
            }}
            className="w-full text-left p-4 rounded-[14px] border transition-all duration-200
              cursor-pointer hover:bg-white/[0.02] bg-surface border-white/[0.06] hover:border-white/[0.12] hover:scale-[1.01]"
            style={{
              animation: 'spring-in 0.5s var(--ease-spring) both',
              animationDelay: `${(allItems.length + idx) * 0.04}s`,
            }}
          >
            <div className="flex items-center justify-between mb-2">
              <div className="min-w-0">
                <div className="font-display text-[14px] font-600 text-text truncate">{gateway.name}</div>
                <div className="text-[11px] text-text-3/60 font-mono truncate">{gateway.endpoint}</div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {gateway.isDefault && (
                  <span className="text-[10px] font-700 px-2 py-0.5 rounded-[5px] bg-accent-bright/10 text-accent-bright uppercase tracking-wider">Default</span>
                )}
                <span className={`w-2 h-2 rounded-full ${
                  gateway.status === 'healthy'
                    ? 'bg-emerald-400'
                    : gateway.status === 'degraded'
                      ? 'bg-amber-400'
                      : gateway.status === 'offline'
                        ? 'bg-red-400'
                        : 'bg-white/10'
                }`} />
              </div>
            </div>
            <div className="text-[12px] text-text-3/70">
              {gateway.tags?.length ? gateway.tags.join(', ') : (gateway.notes || 'Dedicated OpenClaw control plane')}
            </div>
            {!inSidebar && (
              <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-text-3/65">
                <div className="rounded-[10px] border border-white/[0.05] bg-white/[0.02] px-3 py-2">
                  <div className="uppercase tracking-[0.08em] text-text-3/50">Deploy</div>
                  <div className="mt-1 text-text-2">
                    {deployment?.method || 'manual'}
                    {deployment?.provider ? ` · ${deployment.provider}` : ''}
                  </div>
                </div>
                <div className="rounded-[10px] border border-white/[0.05] bg-white/[0.02] px-3 py-2">
                  <div className="uppercase tracking-[0.08em] text-text-3/50">Route hints</div>
                  <div className="mt-1 text-text-2">
                    {deployment?.useCase || 'general'}
                    {deployment?.exposure ? ` · ${deployment.exposure}` : ''}
                  </div>
                </div>
                <div className="rounded-[10px] border border-white/[0.05] bg-white/[0.02] px-3 py-2">
                  <div className="uppercase tracking-[0.08em] text-text-3/50">Nodes / devices</div>
                  <div className="mt-1 text-text-2">
                    {stats?.connectedNodeCount ?? 0}/{stats?.nodeCount ?? 0} nodes · {stats?.pairedDeviceCount ?? 0} devices
                  </div>
                </div>
                <div className="rounded-[10px] border border-white/[0.05] bg-white/[0.02] px-3 py-2">
                  <div className="uppercase tracking-[0.08em] text-text-3/50">Runtimes</div>
                  <div className="mt-1 text-text-2">
                    {runtimeStats.active}/{runtimeStats.total} active
                  </div>
                </div>
              </div>
            )}
            {!inSidebar && deployment?.lastVerifiedMessage && (
              <div className="mt-3 text-[11px] text-text-3/60">
                {deployment.lastVerifiedMessage}
              </div>
            )}
            {!inSidebar && (
              <div className="mt-3 flex items-center gap-2">
                <button onClick={(e) => void handleHealthCheckGateway(e, gateway.id)} className="px-2.5 py-1.5 rounded-[8px] border border-white/[0.08] bg-transparent text-[11px] font-700 text-text-2 hover:bg-white/[0.04] cursor-pointer transition-all">
                  Health
                </button>
                <button onClick={(e) => void handleCloneGateway(e, gateway)} className="px-2.5 py-1.5 rounded-[8px] border border-white/[0.08] bg-transparent text-[11px] font-700 text-text-2 hover:bg-white/[0.04] cursor-pointer transition-all">
                  Clone
                </button>
                <button onClick={(e) => handleDeleteGateway(e, gateway.id)} className="px-2.5 py-1.5 rounded-[8px] border border-red-400/20 bg-red-400/[0.06] text-[11px] font-700 text-red-300 hover:bg-red-400/[0.1] cursor-pointer transition-all">
                  Delete
                </button>
              </div>
            )}
          </div>
            )
          })()
        ))}
        {gatewayProfiles.length === 0 && (
          <div className="p-4 rounded-[14px] border border-dashed border-white/[0.08] text-[13px] text-text-3/70">
            No gateway profiles yet. Use Smart Deploy above for a local runtime, a Docker VPS bundle, or a hosted OpenClaw deployment profile.
          </div>
        )}
      </div>

      {!inSidebar && (
        <>
          <div className="mt-8 mb-4 flex items-center justify-between">
            <div className="text-[12px] font-700 uppercase tracking-[0.08em] text-text-3/60">External Agent Runtimes</div>
            <div className="text-[11px] text-text-3/60">Direct registration + heartbeat</div>
          </div>
          <div className="mb-3 rounded-[12px] border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-[12px] text-text-3/70">
            External workers can register themselves at <code className="text-text-2">/api/external-agents/register</code> and then send heartbeats to
            {' '}
            <code className="text-text-2">/api/external-agents/&lt;id&gt;/heartbeat</code>.
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {externalAgents.map((runtime) => (
              <div key={runtime.id} className="p-4 rounded-[14px] bg-surface border border-white/[0.06]">
                <div className="flex items-center justify-between gap-3 mb-2">
                  <div className="min-w-0">
                    <div className="font-display text-[14px] font-600 text-text truncate">{runtime.name}</div>
                    <div className="text-[11px] text-text-3/60 truncate">
                      {runtime.sourceType} · {runtime.transport || 'custom'}
                      {runtime.version ? ` · ${runtime.version}` : ''}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <span className={`text-[10px] font-700 px-2 py-0.5 rounded-[5px] uppercase tracking-wider ${
                      runtime.lifecycleState === 'cordoned'
                        ? 'bg-red-400/10 text-red-300'
                        : runtime.lifecycleState === 'draining'
                          ? 'bg-amber-400/10 text-amber-300'
                          : 'bg-blue-400/10 text-blue-300'
                    }`}>
                      {runtime.lifecycleState || 'active'}
                    </span>
                    <span className={`text-[10px] font-700 px-2 py-0.5 rounded-[5px] uppercase tracking-wider ${
                      runtime.status === 'online'
                        ? 'bg-emerald-400/10 text-emerald-300'
                        : runtime.status === 'stale'
                          ? 'bg-amber-400/10 text-amber-300'
                          : 'bg-white/[0.04] text-text-3'
                    }`}>
                      {runtime.status}
                    </span>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 text-[11px] text-text-3/65">
                  <div className="rounded-[10px] border border-white/[0.05] bg-white/[0.02] px-3 py-2">
                    <div className="uppercase tracking-[0.08em] text-text-3/50">Provider</div>
                    <div className="mt-1 text-text-2">
                      {runtime.provider || 'No provider'}
                      {runtime.model ? ` · ${runtime.model}` : ''}
                    </div>
                  </div>
                  <div className="rounded-[10px] border border-white/[0.05] bg-white/[0.02] px-3 py-2">
                    <div className="uppercase tracking-[0.08em] text-text-3/50">Gateway</div>
                    <div className="mt-1 text-text-2">
                      {runtime.gatewayProfileId ? (gatewayNameById.get(runtime.gatewayProfileId) || runtime.gatewayProfileId) : 'Standalone'}
                    </div>
                  </div>
                  <div className="rounded-[10px] border border-white/[0.05] bg-white/[0.02] px-3 py-2">
                    <div className="uppercase tracking-[0.08em] text-text-3/50">Template</div>
                    <div className="mt-1 text-text-2">{runtime.gatewayUseCase || 'general'}</div>
                  </div>
                  <div className="rounded-[10px] border border-white/[0.05] bg-white/[0.02] px-3 py-2">
                    <div className="uppercase tracking-[0.08em] text-text-3/50">Last seen</div>
                    <div className="mt-1 text-text-2">{formatRuntimeTimestamp(runtime.lastSeenAt || runtime.lastHeartbeatAt)}</div>
                  </div>
                </div>
                <div className="text-[11px] text-text-3/55 mt-3 font-mono truncate">{runtime.endpoint || runtime.workspace || runtime.id}</div>
                {runtime.gatewayTags?.length ? (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {runtime.gatewayTags.slice(0, 6).map((tag) => (
                      <span key={`${runtime.id}-${tag}`} className="rounded-full border border-white/[0.06] bg-white/[0.03] px-2 py-0.5 text-[10px] font-700 uppercase tracking-[0.08em] text-text-3/70">
                        {tag}
                      </span>
                    ))}
                  </div>
                ) : null}
                {runtime.lastHealthNote && (
                  <div className="mt-3 text-[11px] text-text-3/65 leading-relaxed">
                    {runtime.lastHealthNote}
                  </div>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button onClick={(e) => void handleRuntimeAction(e, runtime.id, 'activate')} className="px-2.5 py-1.5 rounded-[8px] border border-white/[0.08] bg-transparent text-[11px] font-700 text-text-2 hover:bg-white/[0.04] cursor-pointer transition-all">
                    Activate
                  </button>
                  <button onClick={(e) => void handleRuntimeAction(e, runtime.id, 'drain')} className="px-2.5 py-1.5 rounded-[8px] border border-amber-400/20 bg-amber-400/[0.06] text-[11px] font-700 text-amber-300 hover:bg-amber-400/[0.1] cursor-pointer transition-all">
                    Drain
                  </button>
                  <button onClick={(e) => void handleRuntimeAction(e, runtime.id, 'cordon')} className="px-2.5 py-1.5 rounded-[8px] border border-red-400/20 bg-red-400/[0.06] text-[11px] font-700 text-red-300 hover:bg-red-400/[0.1] cursor-pointer transition-all">
                    Cordon
                  </button>
                  <button onClick={(e) => void handleRuntimeAction(e, runtime.id, 'restart')} className="px-2.5 py-1.5 rounded-[8px] border border-white/[0.08] bg-transparent text-[11px] font-700 text-text-2 hover:bg-white/[0.04] cursor-pointer transition-all">
                    Restart
                  </button>
                </div>
              </div>
            ))}
            {externalAgents.length === 0 && (
              <div className="p-4 rounded-[14px] border border-dashed border-white/[0.08] text-[13px] text-text-3/70">
                No external runtimes have registered yet.
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
