'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import { OpenClawDeployPanel } from '@/components/openclaw/openclaw-deploy-panel'
import { useAppStore } from '@/stores/use-app-store'
import { toast } from 'sonner'
import type {
  OpenClawDevicePairRequest,
  OpenClawNode,
  OpenClawNodePairRequest,
  OpenClawPairedDevice,
  GatewayProfile,
} from '@/types'
import { useCreateCredentialMutation, useCredentialsQuery } from '@/features/credentials/queries'
import {
  useCheckOpenClawGatewayMutation,
  useDiscoverOpenClawGatewaysMutation,
  useGatewayInvokeNodeMutation,
  useGatewayPairingDecisionMutation,
  useGatewayProfilesQuery,
  useGatewayRemoveDeviceMutation,
  useRefreshGatewayTopologyMutation,
  useSaveGatewayProfileMutation,
  type GatewayDiscoveryResult,
} from '@/features/gateways/queries'

interface GatewayImportShape {
  name?: string
  endpoint?: string
  credentialId?: string | null
  token?: string | null
  notes?: string | null
  tags?: string[]
  isDefault?: boolean
  deployment?: GatewayProfile['deployment']
}

export function GatewaySheet() {
  const open = useAppStore((s) => s.gatewaySheetOpen)
  const setOpen = useAppStore((s) => s.setGatewaySheetOpen)
  const editingId = useAppStore((s) => s.editingGatewayId)
  const setEditingId = useAppStore((s) => s.setEditingGatewayId)
  const gatewayProfilesQuery = useGatewayProfilesQuery({ enabled: open })
  const credentialsQuery = useCredentialsQuery({ enabled: open })
  const createCredentialMutation = useCreateCredentialMutation()
  const saveGatewayMutation = useSaveGatewayProfileMutation()
  const checkGatewayMutation = useCheckOpenClawGatewayMutation()
  const discoverGatewaysMutation = useDiscoverOpenClawGatewaysMutation()
  const refreshGatewayTopologyMutation = useRefreshGatewayTopologyMutation()
  const gatewayPairingDecisionMutation = useGatewayPairingDecisionMutation()
  const gatewayRemoveDeviceMutation = useGatewayRemoveDeviceMutation()
  const gatewayInvokeNodeMutation = useGatewayInvokeNodeMutation()

  const gatewayProfiles = gatewayProfilesQuery.data ?? []
  const credentials = credentialsQuery.data ?? {}

  const editing = editingId ? gatewayProfiles.find((item) => item.id === editingId) : null
  const openClawCredentials = Object.values(credentials).filter((item) => item.provider === 'openclaw')

  const [name, setName] = useState('')
  const [endpoint, setEndpoint] = useState('http://localhost:18789')
  const [credentialId, setCredentialId] = useState<string | null>(null)
  const [tokenDraft, setTokenDraft] = useState('')
  const [notes, setNotes] = useState('')
  const [tags, setTags] = useState('')
  const [isDefault, setIsDefault] = useState(false)
  const [saving, setSaving] = useState(false)
  const [checking, setChecking] = useState(false)
  const [checkMessage, setCheckMessage] = useState('')
  const [discovering, setDiscovering] = useState(false)
  const [discoveries, setDiscoveries] = useState<GatewayDiscoveryResult[]>([])
  const [nodesLoading, setNodesLoading] = useState(false)
  const [nodesError, setNodesError] = useState('')
  const [nodes, setNodes] = useState<OpenClawNode[]>([])
  const [nodePairings, setNodePairings] = useState<OpenClawNodePairRequest[]>([])
  const [devicePairings, setDevicePairings] = useState<OpenClawDevicePairRequest[]>([])
  const [pairedDevices, setPairedDevices] = useState<OpenClawPairedDevice[]>([])
  const [invokeNodeId, setInvokeNodeId] = useState('')
  const [invokeCommand, setInvokeCommand] = useState('')
  const [invokeParamsText, setInvokeParamsText] = useState('{}')
  const [invokeResult, setInvokeResult] = useState('')
  const [invoking, setInvoking] = useState(false)
  const [deployment, setDeployment] = useState<GatewayProfile['deployment'] | null>(null)
  const importFileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setCheckMessage('')
    setDiscoveries([])
    setNodesError('')
    setInvokeResult('')
    if (editing) {
      setName(editing.name)
      setEndpoint(editing.endpoint)
      setCredentialId(editing.credentialId || null)
      setTokenDraft('')
      setNotes(editing.notes || '')
      setTags((editing.tags || []).join(', '))
      setIsDefault(editing.isDefault === true)
      setDeployment(editing.deployment || null)
      return
    }
    setName('')
    setEndpoint('http://localhost:18789')
    setCredentialId(null)
    setTokenDraft('')
    setNotes('')
    setTags('')
    setIsDefault(gatewayProfiles.length === 0)
    setDeployment(null)
    setNodes([])
    setNodePairings([])
    setDevicePairings([])
    setPairedDevices([])
    setInvokeNodeId('')
    setInvokeCommand('')
    setInvokeParamsText('{}')
  }, [open, editing, gatewayProfiles.length])

  const refreshRef = useRef(refreshGatewayTopologyMutation)
  refreshRef.current = refreshGatewayTopologyMutation

  const loadNodesAndDevices = useCallback(async (profileId: string) => {
    setNodesLoading(true)
    setNodesError('')
    try {
      const result = await refreshRef.current.mutateAsync(profileId)
      setNodes(result.nodes)
      setNodePairings(result.nodePairings)
      setDevicePairings(result.devicePairings)
      setPairedDevices(result.pairedDevices)
      if (result.nodes[0]) {
        setInvokeNodeId((current) => current || result.nodes[0].nodeId)
        setInvokeCommand((current) => current || result.nodes[0].commands?.[0] || '')
      }
    } catch (err: unknown) {
      setNodesError(err instanceof Error ? err.message : 'Failed to load nodes for this gateway.')
    } finally {
      setNodesLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open || !editing?.id) return
    void loadNodesAndDevices(editing.id)
  }, [open, editing?.id, loadNodesAndDevices])

  const onClose = () => {
    setOpen(false)
    setEditingId(null)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      let nextCredentialId = credentialId
      if (tokenDraft.trim()) {
        const created = await createCredentialMutation.mutateAsync({
          provider: 'openclaw',
          name: `${name.trim() || 'OpenClaw Gateway'} token`,
          apiKey: tokenDraft.trim(),
        })
        nextCredentialId = created.id
      }
      const payload = {
        name: name.trim() || 'OpenClaw Gateway',
        endpoint: endpoint.trim() || 'http://localhost:18789',
        credentialId: nextCredentialId || null,
        notes: notes.trim() || null,
        tags: tags.split(',').map((item) => item.trim()).filter(Boolean),
        deployment,
        isDefault,
      }
      await saveGatewayMutation.mutateAsync({
        id: editing?.id,
        payload,
      })
      toast.success(editing ? 'Gateway updated' : 'Gateway added')
      onClose()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to save gateway')
    } finally {
      setSaving(false)
    }
  }

  const handleCheck = async () => {
    setChecking(true)
    setCheckMessage('')
    try {
      const result = await checkGatewayMutation.mutateAsync({
        endpoint,
        credentialId,
        token: tokenDraft,
      })
      if (result.ok) {
        setCheckMessage(result.message || `Connected. ${result.models?.length ? `${result.models.length} model${result.models.length === 1 ? '' : 's'} visible.` : 'Gateway responded normally.'}`)
      } else {
        setCheckMessage(result.error || result.hint || 'Gateway health check failed.')
      }
    } catch (err: unknown) {
      setCheckMessage(err instanceof Error ? err.message : 'Gateway health check failed.')
    } finally {
      setChecking(false)
    }
  }

  const handleDiscover = async () => {
    setDiscovering(true)
    try {
      const result = await discoverGatewaysMutation.mutateAsync()
      setDiscoveries((result.gateways || []).filter((item) => item.healthy))
    } catch {
      setDiscoveries([])
    } finally {
      setDiscovering(false)
    }
  }

  const handlePairingDecision = async (kind: 'node' | 'device', requestId: string, decision: 'approve' | 'reject') => {
    if (!editing?.id) return
    try {
      await gatewayPairingDecisionMutation.mutateAsync({
        profileId: editing.id,
        kind,
        requestId,
        decision,
      })
      toast.success(`${kind === 'node' ? 'Node' : 'Device'} ${decision}d`)
      await loadNodesAndDevices(editing.id)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : `Failed to ${decision} pairing`)
    }
  }

  const handleRemoveDevice = async (deviceId: string) => {
    if (!editing?.id) return
    try {
      await gatewayRemoveDeviceMutation.mutateAsync({ profileId: editing.id, deviceId })
      toast.success('Device removed')
      await loadNodesAndDevices(editing.id)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove device')
    }
  }

  const handleInvoke = async () => {
    if (!editing?.id || !invokeNodeId.trim() || !invokeCommand.trim()) return
    setInvoking(true)
    setInvokeResult('')
    try {
      let parsedParams: Record<string, unknown> = {}
      if (invokeParamsText.trim()) {
        const next = JSON.parse(invokeParamsText)
        if (next && typeof next === 'object' && !Array.isArray(next)) {
          parsedParams = next as Record<string, unknown>
        }
      }
      const result = await gatewayInvokeNodeMutation.mutateAsync({
        profileId: editing.id,
        nodeId: invokeNodeId.trim(),
        command: invokeCommand.trim(),
        params: parsedParams,
      })
      if (result.error) throw new Error(result.error)
      setInvokeResult(JSON.stringify(result.result, null, 2))
      toast.success('Node command sent')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to invoke node command'
      setInvokeResult(message)
      toast.error(message)
    } finally {
      setInvoking(false)
    }
  }

  const inputClass = 'w-full px-4 py-3.5 rounded-[14px] border border-white/[0.08] bg-surface text-text text-[15px] outline-none transition-all duration-200 placeholder:text-text-3/50 focus-glow'

  const applyDeployPatch = (patch: { endpoint?: string; token?: string; name?: string; notes?: string; deployment?: GatewayProfile['deployment'] | Record<string, unknown> | null }) => {
    if (patch.endpoint) {
      setEndpoint(patch.endpoint)
      setCheckMessage('')
    }
    if (patch.token) {
      setTokenDraft(patch.token)
      setCredentialId(null)
    }
    if (patch.name && !name.trim()) {
      setName(patch.name)
    }
    if (patch.notes && !notes.trim()) {
      setNotes(patch.notes)
    }
    if (patch.deployment) {
      setDeployment((current) => ({
        ...(current || {}),
        ...(patch.deployment as GatewayProfile['deployment']),
      }))
    }
  }

  const handleExportGateway = () => {
    const payload: GatewayImportShape = {
      name: name.trim() || 'OpenClaw Gateway',
      endpoint: endpoint.trim() || 'http://localhost:18789',
      credentialId: credentialId || null,
      token: tokenDraft.trim() || null,
      notes: notes.trim() || null,
      tags: tags.split(',').map((item) => item.trim()).filter(Boolean),
      isDefault,
      deployment,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${(payload.name || 'openclaw-gateway').replace(/[^a-zA-Z0-9_-]/g, '_')}.gateway.json`
    link.click()
    URL.revokeObjectURL(url)
    toast.success('Gateway config exported')
  }

  const handleImportGateway = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (loadEvent) => {
      try {
        const parsed = JSON.parse(String(loadEvent.target?.result || '{}')) as GatewayImportShape
        setName(typeof parsed.name === 'string' ? parsed.name : '')
        setEndpoint(typeof parsed.endpoint === 'string' ? parsed.endpoint : 'http://localhost:18789')
        setCredentialId(typeof parsed.credentialId === 'string' ? parsed.credentialId : null)
        setTokenDraft(typeof parsed.token === 'string' ? parsed.token : '')
        setNotes(typeof parsed.notes === 'string' ? parsed.notes : '')
        setTags(Array.isArray(parsed.tags) ? parsed.tags.join(', ') : '')
        setIsDefault(parsed.isDefault === true)
        setDeployment(parsed.deployment || null)
        setCheckMessage('')
        toast.success('Gateway config imported into this form')
      } catch {
        toast.error('Invalid gateway JSON')
      } finally {
        event.target.value = ''
      }
    }
    reader.readAsText(file)
  }

  return (
    <BottomSheet open={open} onClose={onClose} wide>
      <input
        ref={importFileRef}
        type="file"
        accept="application/json,.json"
        onChange={handleImportGateway}
        className="hidden"
      />
      <div className="mb-10">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-[28px] font-700 tracking-[-0.03em] mb-2">
              {editing ? 'Edit Gateway' : 'New Gateway'}
            </h2>
            <p className="text-[14px] text-text-3">
              First-class OpenClaw gateway profiles for local or remote control planes.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => importFileRef.current?.click()}
              className="px-3 py-2 rounded-[10px] border border-white/[0.08] bg-transparent text-text-2 text-[12px] font-600 hover:bg-white/[0.04] transition-all cursor-pointer"
            >
              Import JSON
            </button>
            <button
              type="button"
              onClick={handleExportGateway}
              className="px-3 py-2 rounded-[10px] border border-white/[0.08] bg-transparent text-text-2 text-[12px] font-600 hover:bg-white/[0.04] transition-all cursor-pointer"
            >
              Export JSON
            </button>
          </div>
        </div>
      </div>

      <div className="mb-6">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Local Mac Mini" className={inputClass} />
      </div>

      <div className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em]">Gateway Endpoint</label>
          <button
            type="button"
            onClick={handleDiscover}
            className="text-[11px] text-text-3 hover:text-accent-bright transition-colors cursor-pointer bg-transparent border-none"
          >
            {discovering ? 'Discovering…' : 'Discover local gateways'}
          </button>
        </div>
        <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="http://localhost:18789" className={`${inputClass} font-mono text-[14px]`} />
        <p className="text-[11px] text-text-3/60 mt-2">Remote HTTPS URLs and local loopback endpoints are both supported.</p>
      </div>

      <div className="mb-6">
        <OpenClawDeployPanel
          endpoint={endpoint}
          token={tokenDraft}
          deployment={deployment}
          suggestedName={name || null}
          title="Deploy OpenClaw From SwarmClaw"
          description="Use official OpenClaw sources only. Start it on this host, or generate a pre-configured remote bundle for VPS and hosted deployments."
          onApply={applyDeployPatch}
        />
      </div>

      {deployment && (
        <div className="mb-6 rounded-[16px] border border-white/[0.06] bg-white/[0.02] p-4">
          <div className="text-[12px] font-700 uppercase tracking-[0.08em] text-text-3/70 mb-2">Deploy metadata</div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-[12px] text-text-3/75">
            <div className="rounded-[12px] border border-white/[0.06] bg-surface px-3 py-3">
              <div className="uppercase tracking-[0.08em] text-text-3/55">Method</div>
              <div className="mt-1 text-text-2">{deployment.method || 'manual'}</div>
            </div>
            <div className="rounded-[12px] border border-white/[0.06] bg-surface px-3 py-3">
              <div className="uppercase tracking-[0.08em] text-text-3/55">Use case</div>
              <div className="mt-1 text-text-2">{deployment.useCase || 'general'}</div>
            </div>
            <div className="rounded-[12px] border border-white/[0.06] bg-surface px-3 py-3">
              <div className="uppercase tracking-[0.08em] text-text-3/55">Exposure</div>
              <div className="mt-1 text-text-2">{deployment.exposure || 'manual'}</div>
            </div>
          </div>
          {deployment.lastDeploySummary && (
            <p className="mt-3 text-[12px] text-text-3 leading-relaxed">{deployment.lastDeploySummary}</p>
          )}
          {deployment.lastVerifiedMessage && (
            <p className="mt-2 text-[12px] text-text-3 leading-relaxed">{deployment.lastVerifiedMessage}</p>
          )}
        </div>
      )}

      {discoveries.length > 0 && (
        <div className="mb-6">
          <div className="text-[12px] text-text-3/70 mb-2">Detected healthy gateways</div>
          <div className="flex flex-wrap gap-2">
            {discoveries.map((item) => {
              const detectedEndpoint = `http://${item.host}:${item.port}`
              return (
                <button
                  key={`${item.host}:${item.port}`}
                  type="button"
                  onClick={() => {
                    setEndpoint(detectedEndpoint)
                    if (!name.trim()) setName(`Gateway ${item.host}:${item.port}`)
                  }}
                  className="px-3 py-2 rounded-[10px] border border-white/[0.08] bg-white/[0.03] text-text-2 text-[12px] font-600 hover:bg-white/[0.05] cursor-pointer transition-all"
                >
                  {item.host}:{item.port}
                  {item.models?.length ? ` · ${item.models[0]}` : ''}
                </button>
              )
            })}
          </div>
        </div>
      )}

      <div className="mb-6">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Gateway Token</label>
        <select value={credentialId || ''} onChange={(e) => setCredentialId(e.target.value || null)} className={inputClass}>
          <option value="">No token</option>
          {openClawCredentials.map((item) => (
            <option key={item.id} value={item.id}>{item.name}</option>
          ))}
        </select>
        <input
          value={tokenDraft}
          onChange={(e) => {
            setTokenDraft(e.target.value)
            if (e.target.value) setCredentialId(null)
          }}
          placeholder="Or paste/generate a new gateway token"
          className={`${inputClass} mt-3 font-mono text-[13px]`}
        />
        <p className="mt-2 text-[11px] text-text-3/60">
          A pasted token is stored as a new encrypted OpenClaw credential when you save this gateway.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div>
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Tags</label>
          <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="remote, prod, mac-mini" className={inputClass} />
        </div>
        <div>
          <label className="flex items-center gap-3 pt-8">
            <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
            <span className="text-[14px] text-text-2">Use as default OpenClaw gateway</span>
          </label>
        </div>
      </div>

      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Notes</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} placeholder="Remote tailnet gateway for background coding agents." className={`${inputClass} resize-y min-h-[100px]`} />
      </div>

      {editing && (
        <div className="mb-8 rounded-[18px] border border-white/[0.06] bg-white/[0.02] p-4 md:p-5">
          <div className="flex items-start justify-between gap-3 mb-4">
            <div>
              <div className="font-display text-[18px] font-700 tracking-[-0.02em] text-text">Nodes & Devices</div>
              <p className="text-[12px] text-text-3 mt-1">
                Inspect paired nodes, approve incoming pair requests, and invoke commands on this gateway profile.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void loadNodesAndDevices(editing.id)}
              className="px-3 py-2 rounded-[10px] border border-white/[0.08] bg-transparent text-text-2 text-[12px] font-600 hover:bg-white/[0.04] transition-all cursor-pointer"
            >
              {nodesLoading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>

          {nodesError && (
            <div className="mb-4 rounded-[12px] border border-red-400/20 bg-red-400/[0.06] px-3 py-2 text-[12px] text-red-200">
              {nodesError}
            </div>
          )}

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div className="space-y-4">
              <div className="rounded-[14px] border border-white/[0.06] bg-surface p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="text-[12px] font-700 uppercase tracking-[0.08em] text-text-3/70">Pending Node Pairings</div>
                  <div className="text-[11px] text-text-3/50">{nodePairings.length}</div>
                </div>
                {nodePairings.length > 0 ? (
                  <div className="space-y-2">
                    {nodePairings.map((request) => (
                      <div key={request.requestId} className="rounded-[12px] border border-white/[0.06] bg-white/[0.02] p-3">
                        <div className="text-[13px] font-600 text-text-2">{request.displayName || request.nodeId || request.requestId}</div>
                        <div className="text-[11px] text-text-3/60 mt-1">{request.platform || 'Unknown platform'}{request.remoteIp ? ` · ${request.remoteIp}` : ''}</div>
                        <div className="mt-3 flex gap-2">
                          <button type="button" onClick={() => void handlePairingDecision('node', request.requestId, 'approve')} className="px-2.5 py-1.5 rounded-[8px] bg-emerald-400/10 text-emerald-300 text-[11px] font-700 border-none cursor-pointer hover:bg-emerald-400/15 transition-all">Approve</button>
                          <button type="button" onClick={() => void handlePairingDecision('node', request.requestId, 'reject')} className="px-2.5 py-1.5 rounded-[8px] bg-red-400/10 text-red-300 text-[11px] font-700 border-none cursor-pointer hover:bg-red-400/15 transition-all">Reject</button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-[12px] text-text-3/60">No pending node approvals.</div>
                )}
              </div>

              <div className="rounded-[14px] border border-white/[0.06] bg-surface p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="text-[12px] font-700 uppercase tracking-[0.08em] text-text-3/70">Pending Device Pairings</div>
                  <div className="text-[11px] text-text-3/50">{devicePairings.length}</div>
                </div>
                {devicePairings.length > 0 ? (
                  <div className="space-y-2">
                    {devicePairings.map((request) => (
                      <div key={request.requestId} className="rounded-[12px] border border-white/[0.06] bg-white/[0.02] p-3">
                        <div className="text-[13px] font-600 text-text-2">{request.displayName || request.deviceId || request.requestId}</div>
                        <div className="text-[11px] text-text-3/60 mt-1">{request.role || 'device'}{request.platform ? ` · ${request.platform}` : ''}{request.remoteIp ? ` · ${request.remoteIp}` : ''}</div>
                        <div className="mt-3 flex gap-2">
                          <button type="button" onClick={() => void handlePairingDecision('device', request.requestId, 'approve')} className="px-2.5 py-1.5 rounded-[8px] bg-emerald-400/10 text-emerald-300 text-[11px] font-700 border-none cursor-pointer hover:bg-emerald-400/15 transition-all">Approve</button>
                          <button type="button" onClick={() => void handlePairingDecision('device', request.requestId, 'reject')} className="px-2.5 py-1.5 rounded-[8px] bg-red-400/10 text-red-300 text-[11px] font-700 border-none cursor-pointer hover:bg-red-400/15 transition-all">Reject</button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-[12px] text-text-3/60">No pending device approvals.</div>
                )}
              </div>
            </div>

            <div className="space-y-4">
              <div className="rounded-[14px] border border-white/[0.06] bg-surface p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="text-[12px] font-700 uppercase tracking-[0.08em] text-text-3/70">Connected / Paired Nodes</div>
                  <div className="text-[11px] text-text-3/50">{nodes.length}</div>
                </div>
                {nodes.length > 0 ? (
                  <div className="space-y-2 max-h-[320px] overflow-y-auto pr-1">
                    {nodes.map((node) => (
                      <div key={node.nodeId} className="rounded-[12px] border border-white/[0.06] bg-white/[0.02] p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-[13px] font-600 text-text-2 truncate">{node.displayName || node.nodeId}</div>
                            <div className="text-[11px] text-text-3/60 mt-1">
                              {node.platform || 'Unknown platform'}
                              {node.remoteIp ? ` · ${node.remoteIp}` : ''}
                              {node.deviceFamily ? ` · ${node.deviceFamily}` : ''}
                            </div>
                          </div>
                          <div className={`text-[10px] font-700 uppercase tracking-[0.08em] px-2 py-0.5 rounded-[6px] ${
                            node.connected
                              ? 'bg-emerald-400/10 text-emerald-300'
                              : 'bg-white/[0.05] text-text-3/70'
                          }`}>
                            {node.connected ? 'online' : (node.paired ? 'paired' : 'offline')}
                          </div>
                        </div>
                        {node.commands?.length ? (
                          <div className="mt-2 text-[11px] text-text-3/60 truncate">
                            {node.commands.slice(0, 4).join(', ')}
                            {node.commands.length > 4 ? ` +${node.commands.length - 4}` : ''}
                          </div>
                        ) : null}
                        <div className="mt-3 flex gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setInvokeNodeId(node.nodeId)
                              setInvokeCommand(node.commands?.[0] || invokeCommand)
                            }}
                            className="px-2.5 py-1.5 rounded-[8px] border border-white/[0.08] bg-transparent text-text-2 text-[11px] font-700 hover:bg-white/[0.04] cursor-pointer transition-all"
                          >
                            Use in Invoke
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-[12px] text-text-3/60">No nodes are paired to this gateway yet.</div>
                )}
              </div>

              <div className="rounded-[14px] border border-white/[0.06] bg-surface p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="text-[12px] font-700 uppercase tracking-[0.08em] text-text-3/70">Paired Devices</div>
                  <div className="text-[11px] text-text-3/50">{pairedDevices.length}</div>
                </div>
                {pairedDevices.length > 0 ? (
                  <div className="space-y-2">
                    {pairedDevices.map((device) => (
                      <div key={device.deviceId} className="rounded-[12px] border border-white/[0.06] bg-white/[0.02] p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-[13px] font-600 text-text-2 truncate">{device.displayName || device.deviceId}</div>
                            <div className="text-[11px] text-text-3/60 mt-1">{device.role || 'device'}{device.platform ? ` · ${device.platform}` : ''}{device.remoteIp ? ` · ${device.remoteIp}` : ''}</div>
                          </div>
                          <button type="button" onClick={() => void handleRemoveDevice(device.deviceId)} className="px-2.5 py-1.5 rounded-[8px] bg-red-400/10 text-red-300 text-[11px] font-700 border-none cursor-pointer hover:bg-red-400/15 transition-all">Remove</button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-[12px] text-text-3/60">No paired devices on this gateway.</div>
                )}
              </div>
            </div>
          </div>

          <div className="mt-4 rounded-[14px] border border-white/[0.06] bg-surface p-4">
            <div className="text-[12px] font-700 uppercase tracking-[0.08em] text-text-3/70 mb-3">Invoke Node Command</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
              <select value={invokeNodeId} onChange={(e) => setInvokeNodeId(e.target.value)} className={inputClass}>
                <option value="">Select node</option>
                {nodes.map((node) => (
                  <option key={node.nodeId} value={node.nodeId}>{node.displayName || node.nodeId}</option>
                ))}
              </select>
              <input value={invokeCommand} onChange={(e) => setInvokeCommand(e.target.value)} placeholder="command" className={inputClass} />
            </div>
            <textarea
              value={invokeParamsText}
              onChange={(e) => setInvokeParamsText(e.target.value)}
              rows={5}
              placeholder='{"message":"hello"}'
              className={`${inputClass} font-mono text-[13px] resize-y min-h-[120px]`}
            />
            <div className="mt-3 flex items-center justify-between gap-3">
              <p className="text-[11px] text-text-3/55">
                Use commands exposed by the selected node, such as file, shell, or notification actions that gateway policy allows.
              </p>
              <button type="button" onClick={handleInvoke} disabled={invoking || !invokeNodeId || !invokeCommand.trim()} className="px-3 py-2 rounded-[10px] bg-accent-bright text-white text-[12px] font-700 border-none hover:brightness-110 transition-all cursor-pointer disabled:opacity-40">
                {invoking ? 'Sending…' : 'Invoke'}
              </button>
            </div>
            {invokeResult && (
              <pre className="mt-3 rounded-[12px] border border-white/[0.06] bg-black/20 p-3 text-[11px] text-text-2/80 overflow-x-auto whitespace-pre-wrap">
                {invokeResult}
              </pre>
            )}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <div className="text-[12px] text-text-3/70">
          {checkMessage || 'Run a health check before saving if you want to verify endpoint + token.'}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={handleCheck} className="px-3 py-2 rounded-[10px] border border-white/[0.08] bg-transparent text-text-2 text-[12px] font-600 hover:bg-white/[0.04] transition-all cursor-pointer">
            {checking ? 'Checking…' : 'Health Check'}
          </button>
          <button type="button" onClick={handleSave} disabled={saving} className="px-4 py-2 rounded-[10px] bg-accent-bright text-white text-[12px] font-700 border-none hover:brightness-110 transition-all cursor-pointer disabled:opacity-40">
            {saving ? 'Saving…' : (editing ? 'Save Gateway' : 'Create Gateway')}
          </button>
        </div>
      </div>
    </BottomSheet>
  )
}
