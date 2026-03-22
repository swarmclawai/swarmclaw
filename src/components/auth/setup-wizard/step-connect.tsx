'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/app/api-client'
import { dedup, errorMessage } from '@/lib/shared-utils'
import { getDefaultModelForProvider } from '@/lib/setup-defaults'
import { OpenClawDeployPanel } from '@/components/openclaw/openclaw-deploy-panel'
import type { Credential, Credentials, GatewayProfile, ProviderId, ProviderConfig } from '@/types'
import type { StepConnectProps, CheckState, ProviderCheckResponse, ConfiguredProvider } from './types'
import {
  formatEndpointHost,
  isLocalOpenClawEndpoint,
  resolveOpenClawDashboardUrl,
  getOpenClawErrorHint,
} from './utils'
import { StepShell, SkipLink } from './shared'

export function StepConnect({
  provider,
  selectedProvider,
  initialLabel,
  editingProvider,
  onSaveProvider,
  onBack,
  onSkip,
}: StepConnectProps) {
  const [providerLabel, setProviderLabel] = useState(editingProvider?.name || initialLabel)
  const [endpoint, setEndpoint] = useState(editingProvider?.endpoint || selectedProvider.defaultEndpoint || '')
  const [apiKey, setApiKey] = useState('')
  const [credentialId, setCredentialId] = useState<string | null>(editingProvider?.credentialId || null)
  const [providerNotes, setProviderNotes] = useState(editingProvider?.notes || '')
  const [providerTags, setProviderTags] = useState<string[]>(editingProvider?.tags || [])
  const [providerDeployment, setProviderDeployment] = useState<GatewayProfile['deployment'] | null>(editingProvider?.deployment || null)
  const [checkState, setCheckState] = useState<CheckState>(editingProvider?.verified ? 'ok' : 'idle')
  const [checkMessage, setCheckMessage] = useState('')
  const [checkErrorCode, setCheckErrorCode] = useState<string | null>(null)
  const [openclawDeviceId, setOpenclawDeviceId] = useState<string | null>(null)
  const [providerSuggestedModel, setProviderSuggestedModel] = useState(
    editingProvider?.defaultModel || (provider === 'custom' ? '' : getDefaultModelForProvider(provider)),
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [existingCredentials, setExistingCredentials] = useState<Credential[]>([])
  const [addingNewKey, setAddingNewKey] = useState(!editingProvider?.credentialId)

  // Load saved credentials for this provider type on mount
  useEffect(() => {
    let cancelled = false
    api<Credentials>('GET', '/credentials').then((creds) => {
      if (cancelled) return
      const providerType = provider === 'custom' ? 'openai' : provider
      const matching = Object.values(creds).filter((c) => c.provider === providerType || c.provider === provider)
      setExistingCredentials(matching)
      // If there are existing credentials and user hasn't entered a key yet, default to dropdown mode
      if (matching.length > 0) setAddingNewKey(false)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [provider])

  const hasExistingCredentials = existingCredentials.length > 0

  const isCustom = provider === 'custom'
  const isOllamaCloud = provider === 'ollama' && endpoint.trim() === (selectedProvider.cloudEndpoint || '')
  const requiresKey = selectedProvider.requiresKey || isOllamaCloud
  const supportsEndpoint = selectedProvider.supportsEndpoint || isCustom
  const keyIsOptional = (selectedProvider.optionalKey && !isOllamaCloud) || isCustom
  const requiresVerifiedConnection = provider === 'openclaw'
  const canCheckConnection = !isCustom
  const openClawEndpointValue = provider === 'openclaw'
    ? (endpoint.trim() || selectedProvider.defaultEndpoint || 'http://localhost:18789/v1')
    : null
  const openClawEndpointHost = openClawEndpointValue ? formatEndpointHost(openClawEndpointValue) : null
  const openClawDashboardUrl = provider === 'openclaw'
    ? resolveOpenClawDashboardUrl(openClawEndpointValue)
    : null
  const openClawLocal = provider === 'openclaw' ? isLocalOpenClawEndpoint(openClawEndpointValue) : false

  const applyOpenClawDeployPatch = (patch: {
    endpoint?: string
    token?: string
    name?: string
    notes?: string
    deployment?: GatewayProfile['deployment'] | Record<string, unknown> | null
  }) => {
    if (patch.endpoint) {
      setEndpoint(patch.endpoint)
    }
    if (patch.token) {
      setApiKey(patch.token)
      setCredentialId(null)
    }
    if (patch.name && (!providerLabel.trim() || providerLabel.trim() === (selectedProvider.name || '') || providerLabel.trim() === initialLabel)) {
      setProviderLabel(patch.name)
    }
    if (patch.notes) {
      setProviderNotes(patch.notes)
    }
    if (patch.deployment) {
      const nextDeployment = patch.deployment as GatewayProfile['deployment']
      setProviderDeployment((current) => ({
        ...(current || {}),
        ...(nextDeployment || {}),
      }))
      setProviderTags((current) => dedup([
        ...current,
        'onboarding',
        ...(nextDeployment?.useCase ? [nextDeployment.useCase] : []),
        ...(nextDeployment?.exposure ? [nextDeployment.exposure] : []),
      ]))
    }
    setCheckState('idle')
    setCheckMessage('')
    setCheckErrorCode(null)
    setError('')
  }

  const runConnectionCheck = async (): Promise<boolean> => {
    if (requiresKey && !hasKeyOrCredential) {
      setCheckState('error')
      setCheckMessage('Please paste your API key or select a saved key first.')
      return false
    }

    setCheckState('checking')
    setCheckMessage('')
    setCheckErrorCode(null)
    setError('')
    try {
      const result = await api<ProviderCheckResponse>('POST', '/setup/check-provider', {
        provider: isCustom ? 'openai' : provider,
        apiKey: apiKey.trim() || undefined,
        credentialId: (!apiKey.trim() && credentialId) ? credentialId : undefined,
        endpoint: supportsEndpoint ? endpoint.trim() || undefined : undefined,
      })

      if (result.normalizedEndpoint && supportsEndpoint) {
        setEndpoint(result.normalizedEndpoint)
      }
      if (result.recommendedModel) {
        setProviderSuggestedModel(result.recommendedModel)
      }
      setCheckErrorCode(result.errorCode || null)
      setOpenclawDeviceId(result.deviceId || null)
      setCheckState(result.ok ? 'ok' : 'error')
      setCheckMessage(result.message || (result.ok ? 'Connected successfully.' : 'Connection failed.'))
      return !!result.ok
    } catch (err: unknown) {
      setCheckState('error')
      setCheckMessage(errorMessage(err))
      setCheckErrorCode(null)
      return false
    }
  }

  const hasKeyOrCredential = !!apiKey.trim() || !!credentialId

  const saveProvider = async () => {
    if (requiresKey && !hasKeyOrCredential) {
      setError('This provider requires an API key.')
      return
    }

    if (isCustom && !endpoint.trim()) {
      setError('Custom providers need a base URL endpoint.')
      return
    }

    if (isCustom && !providerSuggestedModel.trim()) {
      setError('Custom providers need a default model ID.')
      return
    }

    setSaving(true)
    setError('')
    try {
      if (requiresVerifiedConnection && checkState !== 'ok') {
        const ok = await runConnectionCheck()
        if (!ok) {
          setError('OpenClaw must pass connection verification before continuing.')
          return
        }
      }

      let nextCredentialId = credentialId
      const shouldSaveCredential = !!apiKey.trim() && !credentialId && (requiresKey || keyIsOptional)

      if (shouldSaveCredential) {
        const credProvider = isCustom ? 'openai' : provider
        const cred = await api<Credential>('POST', '/credentials', {
          provider: credProvider,
          name: `${providerLabel.trim() || selectedProvider.name} key`,
          apiKey: apiKey.trim(),
        })
        nextCredentialId = cred.id
      }

      // Custom providers: create a ProviderConfig in the DB so agents can reference it
      let resolvedProvider: ProviderId = provider
      if (isCustom) {
        const customConfig = await api<ProviderConfig>('POST', '/providers', {
          name: providerLabel.trim() || 'Custom Provider',
          baseUrl: endpoint.trim(),
          models: providerSuggestedModel.trim() ? [providerSuggestedModel.trim()] : [],
          requiresApiKey: hasKeyOrCredential,
          credentialId: nextCredentialId || null,
          isEnabled: true,
        })
        resolvedProvider = customConfig.id as ProviderId
      }

      // Build a tokenized dashboard URL for OpenClaw so step-agents can link to it
      let dashboardUrl: string | null = null
      if (provider === 'openclaw') {
        const base = resolveOpenClawDashboardUrl(endpoint.trim() || selectedProvider.defaultEndpoint)
        dashboardUrl = apiKey.trim() ? `${base}?token=${encodeURIComponent(apiKey.trim())}` : base
      }

      const configured: ConfiguredProvider = {
        id: Math.random().toString(16).slice(2, 10),
        setupProvider: provider,
        provider: resolvedProvider,
        name: providerLabel.trim() || selectedProvider.name,
        credentialId: nextCredentialId || null,
        endpoint: supportsEndpoint ? (endpoint.trim() || selectedProvider.defaultEndpoint || null) : null,
        defaultModel: providerSuggestedModel.trim() || (isCustom ? '' : getDefaultModelForProvider(provider)),
        gatewayProfileId: null,
        notes: providerNotes.trim() || null,
        tags: providerTags,
        deployment: providerDeployment,
        verified: checkState === 'ok',
        dashboardUrl,
      }

      onSaveProvider(configured)
    } catch (err: unknown) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <StepShell wide>
      <h1 className="font-display text-[36px] font-800 leading-[1.05] tracking-[-0.04em] mb-3">
        {editingProvider ? 'Edit' : 'Connect'} {selectedProvider.name}
      </h1>
      <p className="text-[15px] text-text-2 mb-2">
        Save this provider once, then reuse it across your starter agents.
      </p>
      <p className="text-[13px] text-text-3 mb-7">
        {requiresVerifiedConnection
          ? 'OpenClaw must pass connection check before you can continue.'
          : 'You can still continue even if the check fails and fix details later.'}
      </p>

      <div className="flex flex-col gap-3 text-left mb-4">
        <div>
          <label className="block text-[12px] text-text-3 font-500 mb-1.5 ml-1">
            Connection name
          </label>
          <input
            type="text"
            value={providerLabel}
            onChange={(e) => setProviderLabel(e.target.value)}
            placeholder={selectedProvider.name}
            className="w-full px-4 py-3 rounded-[12px] border border-white/[0.08] bg-surface
              text-text text-[14px] outline-none transition-all duration-200
              focus:border-accent-bright/30 focus:shadow-[0_0_30px_rgba(99,102,241,0.1)]"
          />
          <p className="mt-1.5 text-[11px] text-text-3">
            Helpful for multiple OpenClaw gateways or distinct provider profiles.
          </p>
        </div>

        {supportsEndpoint && (
          <div>
            <label className="block text-[12px] text-text-3 font-500 mb-1.5 ml-1">
              Endpoint
            </label>
            <input
              type="text"
              value={endpoint}
              onChange={(e) => { setEndpoint(e.target.value); setCheckState('idle'); setCheckMessage('') }}
              placeholder={selectedProvider.defaultEndpoint || ''}
              className="w-full px-4 py-3 rounded-[12px] border border-white/[0.08] bg-surface
                text-text text-[14px] font-mono outline-none transition-all duration-200
                focus:border-accent-bright/30 focus:shadow-[0_0_30px_rgba(99,102,241,0.1)]"
            />
            {selectedProvider.cloudEndpoint && (
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const isCloud = endpoint.trim() === selectedProvider.cloudEndpoint
                    setEndpoint(isCloud ? (selectedProvider.defaultEndpoint || '') : selectedProvider.cloudEndpoint!)
                    setCheckState('idle')
                    setCheckMessage('')
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] border text-[12px] font-500 cursor-pointer transition-all duration-200 bg-transparent
                    border-white/[0.08] text-text-2 hover:bg-white/[0.04]"
                >
                  {endpoint.trim() === selectedProvider.cloudEndpoint ? (
                    <>
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                      Switch to Local
                    </>
                  ) : (
                    <>
                      <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                      Switch to {selectedProvider.name} Cloud
                    </>
                  )}
                </button>
                <span className="text-[11px] text-text-3">
                  {endpoint.trim() === selectedProvider.cloudEndpoint
                    ? 'Using cloud endpoint — API key required'
                    : `Local at ${selectedProvider.defaultEndpoint || 'localhost'}`}
                </span>
              </div>
            )}
            {isCustom && (
              <p className="mt-1.5 text-[11px] text-text-3">
                Paste the base URL of any OpenAI-compatible API (e.g. <code className="text-text-2">https://openrouter.ai/api/v1</code>).
              </p>
            )}
            {provider === 'openclaw' && (
              <div className="mt-2 space-y-0.5">
                <p className="text-[12px] text-text-3">Works with local (<code className="text-text-2">http://localhost:18789/v1</code>) or remote OpenClaw instances.</p>
                <p className="text-[12px] text-text-3">Remote example: <code className="text-text-2">https://your-gateway.ts.net/v1</code>.</p>
              </div>
            )}
          </div>
        )}

        {isCustom && (
          <div>
            <label className="block text-[12px] text-text-3 font-500 mb-1.5 ml-1">
              Default model
            </label>
            <input
              type="text"
              value={providerSuggestedModel}
              onChange={(e) => setProviderSuggestedModel(e.target.value)}
              placeholder="e.g. gpt-4o-mini"
              className="w-full px-4 py-3 rounded-[12px] border border-white/[0.08] bg-surface
                text-text text-[14px] font-mono outline-none transition-all duration-200
                focus:border-accent-bright/30 focus:shadow-[0_0_30px_rgba(99,102,241,0.1)]"
            />
            <p className="mt-1.5 text-[11px] text-text-3">
              Save the model ID you want starter agents to use with this provider. You can change it later per agent.
            </p>
          </div>
        )}

        {provider === 'openclaw' && (
          <div className="rounded-[14px] border border-white/[0.08] bg-surface p-4 space-y-4">
            <OpenClawDeployPanel
              compact
              endpoint={openClawEndpointValue}
              token={apiKey}
              suggestedName={providerLabel || selectedProvider.name}
              title="Smart Deploy OpenClaw"
              description="Launch the bundled official OpenClaw gateway locally, or generate an official-image VPS bundle for major providers without relying on third-party deployment services."
              onApply={applyOpenClawDeployPatch}
            />

            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-[12px] border border-white/[0.06] bg-bg px-4 py-3">
                <div className="text-[12px] uppercase tracking-[0.08em] text-text-3 mb-2">Remote gateway</div>
                <p className="text-[13px] text-text-2 leading-relaxed">
                  Recommended when your OpenClaw node runs on another machine or VPS. Use a URL reachable from the machine running SwarmClaw.
                </p>
                <p className="mt-2 text-[12px] text-text-3 leading-relaxed">
                  Tailscale example: <code className="text-text-2">https://&lt;gateway-host&gt;.ts.net/v1</code>
                </p>
                <p className="mt-2 text-[12px] text-text-3 leading-relaxed">
                  If you only have a WebSocket gateway URL, you can still paste it here. SwarmClaw will normalize it for agent chat.
                </p>
                <p className="mt-2 text-[12px] text-text-3 leading-relaxed">
                  Safer remote defaults: use <code className="text-text-2">private-tailnet</code> with <code className="text-text-2">tailscale</code> or <code className="text-text-2">ssh-tunnel</code> unless you intentionally want public HTTPS ingress.
                </p>
              </div>
              <div className="rounded-[12px] border border-white/[0.06] bg-bg px-4 py-3">
                <div className="text-[12px] uppercase tracking-[0.08em] text-text-3 mb-2">Safe defaults</div>
                <p className="text-[13px] text-text-2 leading-relaxed">
                  Smart Deploy generates a gateway token for you, defaults to the standard OpenClaw ports, and prefills this setup form automatically.
                </p>
                <p className="mt-2 text-[12px] text-text-3 leading-relaxed">
                  Local quickstart uses the bundled official OpenClaw CLI. Remote quickstart uses the official OpenClaw Docker image or the official repo for managed hosts.
                </p>
                <p className="mt-2 text-[12px] text-text-3 leading-relaxed">
                  Choose <code className="text-text-2">local-dev</code> for one-machine setup, <code className="text-text-2">single-vps</code> for most hosted installs, or <code className="text-text-2">private-tailnet</code> when the gateway should stay private.
                </p>
              </div>
            </div>

            <div className="rounded-[12px] border border-white/[0.06] bg-bg px-4 py-3">
              <div className="text-[12px] uppercase tracking-[0.08em] text-text-3 mb-2">Connection mental model</div>
              <p className="text-[12px] text-text-3 leading-relaxed">
                SwarmClaw talks to this endpoint from its own host. If SwarmClaw is on a server, <code className="text-text-2">localhost</code> means that server, not your laptop.
              </p>
              <p className="mt-2 text-[12px] text-text-3 leading-relaxed">
                Current target: <span className="text-text-2">{openClawEndpointHost || 'localhost:18789'}</span>{openClawLocal ? ' · local route' : ' · remote route'}
              </p>
              <p className="mt-2 text-[12px] text-text-3 leading-relaxed">
                Use <code className="text-text-2">caddy</code> or <code className="text-text-2">nginx</code> only when you intentionally want HTTPS/public ingress managed on the gateway side.
              </p>
            </div>
          </div>
        )}

        {(requiresKey || keyIsOptional) && (
          <div>
            <label className="block text-[12px] text-text-3 font-500 mb-1.5 ml-1">
              {keyIsOptional ? 'API key (optional)' : 'API key'}
            </label>
            {hasExistingCredentials && !addingNewKey ? (
              <div className="flex gap-2">
                <select
                  value={credentialId || ''}
                  onChange={(e) => {
                    if (e.target.value === '__add__') {
                      setAddingNewKey(true)
                      setCredentialId(null)
                      setApiKey('')
                    } else {
                      setCredentialId(e.target.value || null)
                      setApiKey('')
                      setCheckState('idle')
                      setCheckMessage('')
                    }
                  }}
                  className="w-full px-4 py-3 rounded-[12px] border border-white/[0.08] bg-surface
                    text-text text-[14px] outline-none transition-all duration-200 appearance-none cursor-pointer
                    focus:border-accent-bright/30 focus:shadow-[0_0_30px_rgba(99,102,241,0.1)]"
                >
                  <option value="">Select a saved key...</option>
                  {existingCredentials.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                  <option value="__add__">+ Add new key...</option>
                </select>
                <button
                  type="button"
                  onClick={() => { setAddingNewKey(true); setCredentialId(null); setApiKey('') }}
                  className="shrink-0 px-3 py-2.5 rounded-[12px] border border-white/[0.08] bg-white/[0.03] text-text-2 text-[12px] font-500
                    cursor-pointer hover:bg-white/[0.06] transition-all duration-200"
                >
                  + New
                </button>
              </div>
            ) : (
              <div>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => { setApiKey(e.target.value); setCredentialId(null); setCheckState('idle'); setCheckMessage(''); setError('') }}
                  placeholder={selectedProvider.keyPlaceholder || (provider === 'openclaw' ? 'Paste OpenClaw bearer token' : 'sk-...')}
                  className="w-full px-4 py-3 rounded-[12px] border border-white/[0.08] bg-surface
                    text-text text-[14px] font-mono outline-none transition-all duration-200
                    focus:border-accent-bright/30 focus:shadow-[0_0_30px_rgba(99,102,241,0.1)]"
                />
                {hasExistingCredentials && (
                  <button
                    type="button"
                    onClick={() => { setAddingNewKey(false); setApiKey('') }}
                    className="mt-1.5 text-[11px] text-accent-bright hover:underline bg-transparent border-none cursor-pointer"
                  >
                    Use a saved key instead
                  </button>
                )}
              </div>
            )}
            {isOllamaCloud ? (
              <p className="text-[11px] text-text-3 mt-1.5">
                Get one at{' '}
                <a href="https://ollama.com/settings/keys" target="_blank" rel="noopener noreferrer" className="text-accent-bright hover:underline">
                  ollama.com
                </a>
              </p>
            ) : selectedProvider.keyUrl ? (
              <p className="text-[11px] text-text-3 mt-1.5">
                Get one at{' '}
                <a
                  href={selectedProvider.keyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent-bright hover:underline"
                >
                  {selectedProvider.keyLabel}
                </a>
              </p>
            ) : null}
          </div>
        )}
      </div>

      {checkState !== 'idle' && (
        <div
          className={`mb-4 px-3 py-2 rounded-[10px] text-[12px] border ${
            checkState === 'ok'
              ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
              : checkState === 'checking'
                ? 'bg-white/[0.03] border-white/[0.08] text-text-2'
                : 'bg-red-500/10 border-red-500/25 text-red-300'
          }`}
        >
          {checkState === 'checking' ? 'Checking connection...' : checkMessage}
          {checkState === 'error' && provider === 'openclaw' && (() => {
            const hint = getOpenClawErrorHint(checkMessage)
            return hint ? <p className="mt-1.5 text-[11px] text-text-3">{hint}</p> : null
          })()}
          {providerSuggestedModel && (
            <p className="mt-1.5 text-[11px] text-text-3">Suggested model: {providerSuggestedModel}</p>
          )}
          {provider === 'openclaw' && checkState === 'ok' && openclawDeviceId && (
            <p className="mt-1.5 text-[11px] text-text-3">
              Device paired as <code className="text-text-2">{openclawDeviceId.slice(0, 12)}...</code>.
            </p>
          )}
        </div>
      )}

      {provider === 'openclaw' && checkState === 'error' && checkErrorCode === 'PAIRING_REQUIRED' && (
        <div className="mb-4 rounded-[12px] border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 text-left">
          <div className="text-[13px] font-600 text-emerald-300">Awaiting gateway approval</div>
          <p className="mt-1.5 text-[12px] text-text-3 leading-relaxed">
            This device is pending approval on that OpenClaw gateway. Approve it from Nodes, then run the connection check again.
            {openclawDeviceId ? (
              <> Device: <code className="text-text-2">{openclawDeviceId}</code>.</>
            ) : null}
          </p>
          {openClawDashboardUrl && (
            <a
              href={openClawDashboardUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex items-center gap-1.5 rounded-[10px] border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-[12px] text-text hover:bg-white/[0.06] transition-all duration-200"
            >
              Open gateway dashboard
            </a>
          )}
        </div>
      )}

      {provider === 'openclaw' && checkState === 'error' && checkErrorCode === 'DEVICE_AUTH_INVALID' && (
        <div className="mb-4 rounded-[12px] border border-white/[0.08] bg-surface px-4 py-3 text-left">
          <div className="text-[13px] font-600 text-text">Device not paired</div>
          <p className="mt-1.5 text-[12px] text-text-3 leading-relaxed">
            The gateway does not recognize this device yet. Add or approve it from Nodes, then retry.
            {openclawDeviceId ? (
              <> Device: <code className="text-text-2">{openclawDeviceId}</code>.</>
            ) : null}
          </p>
        </div>
      )}

      {error && <p className="mb-4 text-[13px] text-red-400">{error}</p>}

      <div className="flex items-center justify-center gap-3">
        <button
          onClick={onBack}
          className="px-6 py-3.5 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[14px]
            font-display font-500 cursor-pointer hover:bg-white/[0.03] transition-all duration-200"
        >
          Back
        </button>
        {canCheckConnection && (
          <button
            onClick={runConnectionCheck}
            disabled={checkState === 'checking' || saving}
            className="px-6 py-3.5 rounded-[14px] border border-white/[0.08] bg-white/[0.03] text-text text-[14px]
              font-display font-600 cursor-pointer hover:bg-white/[0.06] transition-all duration-200 disabled:opacity-40"
          >
            {checkState === 'checking' ? 'Checking...' : 'Check Connection'}
          </button>
        )}
        <button
          onClick={saveProvider}
          disabled={(requiresKey && !hasKeyOrCredential) || (isCustom && !providerSuggestedModel.trim()) || saving}
          className="px-8 py-3.5 rounded-[14px] border-none bg-accent-bright text-white text-[15px] font-display font-600
            cursor-pointer hover:brightness-110 active:scale-[0.97] transition-all duration-200
            shadow-[0_6px_28px_rgba(99,102,241,0.3)] disabled:opacity-30"
        >
          {saving ? 'Saving...' : editingProvider ? 'Update Provider' : 'Save Provider'}
        </button>
      </div>

      <SkipLink onClick={onSkip} />
    </StepShell>
  )
}
