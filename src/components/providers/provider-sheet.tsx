'use client'

import { useEffect, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { createProviderConfig, updateProviderConfig, deleteProviderConfig } from '@/lib/provider-config'
import { api } from '@/lib/app/api-client'
import { fetchProviderModelDiscovery } from '@/lib/provider-model-discovery-client'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import { ConfirmDialog } from '@/components/shared/confirm-dialog'
import { toast } from 'sonner'
import { errorMessage } from '@/lib/shared-utils'

export function ProviderSheet() {
  const open = useAppStore((s) => s.providerSheetOpen)
  const setOpen = useAppStore((s) => s.setProviderSheetOpen)
  const editingId = useAppStore((s) => s.editingProviderId)
  const setEditingId = useAppStore((s) => s.setEditingProviderId)
  const providerConfigs = useAppStore((s) => s.providerConfigs)
  const loadProviderConfigs = useAppStore((s) => s.loadProviderConfigs)
  const providers = useAppStore((s) => s.providers)
  const loadProviders = useAppStore((s) => s.loadProviders)
  const credentials = useAppStore((s) => s.credentials)
  const loadCredentials = useAppStore((s) => s.loadCredentials)

  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [models, setModels] = useState('')
  const [requiresApiKey, setRequiresApiKey] = useState(true)
  const [credentialId, setCredentialId] = useState<string | null>(null)
  const [isEnabled, setIsEnabled] = useState(true)
  const [addingKey, setAddingKey] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [newKeyValue, setNewKeyValue] = useState('')
  const [savingKey, setSavingKey] = useState(false)
  const [newModel, setNewModel] = useState('')

  // Test connection state
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'pass' | 'fail'>('idle')
  const [testMessage, setTestMessage] = useState('')

  const [liveModels, setLiveModels] = useState<string[]>([])
  const [liveLoading, setLiveLoading] = useState(false)
  const [liveMessage, setLiveMessage] = useState('')
  const [liveCached, setLiveCached] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // Find editing provider in custom configs OR built-in list
  const editingCustom = editingId ? providerConfigs.find((c) => c.id === editingId) : null
  const editingBuiltin = editingId ? providers.find((p) => p.id === editingId) : null
  const isBuiltin = !!editingBuiltin && !editingCustom
  const editing = editingCustom || editingBuiltin

  useEffect(() => {
    if (open) {
      loadCredentials()
      setNewModel('')
      setLiveModels([])
      setLiveMessage('')
      setLiveCached(false)
      setTestStatus('idle')
      setTestMessage('')
      if (editingCustom) {
        setName(editingCustom.name)
        setBaseUrl(editingCustom.baseUrl || '')
        setModels(editingCustom.models.join(', '))
        setRequiresApiKey(editingCustom.requiresApiKey)
        setCredentialId(editingCustom.credentialId || null)
        setIsEnabled(editingCustom.isEnabled)
      } else if (editingBuiltin) {
        setName(editingBuiltin.name)
        setBaseUrl(editingBuiltin.defaultEndpoint || '')
        setModels(editingBuiltin.models.join(', '))
        setRequiresApiKey(editingBuiltin.requiresApiKey)
        // Default to existing credential for this provider
        const existingCred = Object.values(credentials).find((c) => c.provider === editingBuiltin.id)
        setCredentialId(existingCred?.id || null)
        setIsEnabled(true)
      } else {
        setName('')
        setBaseUrl('')
        setModels('')
        setRequiresApiKey(true)
        setCredentialId(null)
        setIsEnabled(true)
      }
    }
  }, [open, editingId, credentials, editingBuiltin, editingCustom, loadCredentials])

  // Reset test status when connection params change
  useEffect(() => {
    setTestStatus('idle')
    setTestMessage('')
  }, [credentialId, baseUrl])

  useEffect(() => {
    setLiveModels([])
    setLiveMessage('')
    setLiveCached(false)
  }, [editingId, credentialId, baseUrl, requiresApiKey])

  const handleTestConnection = async () => {
    setTestStatus('testing')
    setTestMessage('')
    try {
      const result = await api<{ ok: boolean; message: string }>('POST', '/setup/check-provider', {
        provider: editingId || 'custom',
        credentialId,
        endpoint: baseUrl,
      })
      if (result.ok) {
        setTestStatus('pass')
        setTestMessage(result.message)
        toast.success('Connection successful')
      } else {
        setTestStatus('fail')
        setTestMessage(result.message)
        toast.error(result.message || 'Connection failed')
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Connection test failed'
      setTestStatus('fail')
      setTestMessage(msg)
      toast.error(msg)
    }
  }

  const onClose = () => {
    setConfirmDelete(false)
    setDeleting(false)
    setOpen(false)
    setEditingId(null)
  }

  const handleSave = async () => {
    try {
      if (isBuiltin) {
        // Save model overrides for built-in providers
        const modelList = models.split(',').map((m) => m.trim()).filter(Boolean)
        await api('PUT', `/providers/${editingId}/models`, { models: modelList })
        toast.success('Built-in provider models updated')
        await loadProviders()
        onClose()
        return
      }
      const modelList = models.split(',').map((m) => m.trim()).filter(Boolean)
      const data = {
        name: name.trim() || 'Custom Provider',
        baseUrl: baseUrl.trim(),
        models: modelList,
        requiresApiKey,
        credentialId,
        isEnabled,
      }
      if (editingCustom) {
        await updateProviderConfig(editingCustom.id, data)
        toast.success('Provider updated')
      } else {
        await createProviderConfig(data)
        toast.success('Provider created')
      }
      await loadProviderConfigs()
      onClose()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to save provider')
    }
  }

  const handleDelete = async () => {
    if (editingCustom) {
      setDeleting(true)
      try {
        await deleteProviderConfig(editingCustom.id)
        toast.success('Provider deleted')
        await loadProviderConfigs()
        setConfirmDelete(false)
        onClose()
      } catch (err: unknown) {
        toast.error(err instanceof Error ? err.message : 'Failed to delete provider')
      } finally {
        setDeleting(false)
      }
    }
  }

  const handleResetModels = async () => {
    if (isBuiltin && editingId) {
      await api('DELETE', `/providers/${editingId}/models`)
      await loadProviders()
      // Re-read the reset models
      const updated = providers.find((p) => p.id === editingId)
      if (updated) setModels(updated.models.join(', '))
    }
  }

  const handleAddModel = () => {
    if (!newModel.trim()) return
    const current = models ? models + ', ' + newModel.trim() : newModel.trim()
    setModels(current)
    setNewModel('')
  }

  const handleRemoveModel = (index: number) => {
    const list = models.split(',').map((m) => m.trim()).filter(Boolean)
    list.splice(index, 1)
    setModels(list.join(', '))
  }

  const handleLoadLiveModels = async (force = false) => {
    if (!open) return
    const providerId = editingId || 'custom'
    setLiveLoading(true)
    setLiveMessage('')
    try {
      const result = await fetchProviderModelDiscovery({
        providerId,
        credentialId,
        endpoint: baseUrl,
        force,
        requiresApiKey: isBuiltin ? undefined : requiresApiKey,
      })
      setLiveModels(result.models)
      setLiveCached(result.cached)
      setLiveMessage(result.message || '')
      if (!result.ok) {
        toast.message(result.message || 'Live model discovery is unavailable.')
        return
      }
      setModels(result.models.join(', '))
      toast.success(`Loaded ${result.models.length} live model${result.models.length === 1 ? '' : 's'}`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load live models'
      setLiveMessage(message)
      toast.error(message)
    } finally {
      setLiveLoading(false)
    }
  }

  const credList = Object.values(credentials)
  const modelList = models.split(',').map((m) => m.trim()).filter(Boolean)
  const showApiKey = isBuiltin ? editingBuiltin?.requiresApiKey || editingBuiltin?.optionalApiKey : requiresApiKey
  const canDiscoverModels = isBuiltin
    ? Boolean(editingBuiltin?.supportsModelDiscovery)
    : !!baseUrl.trim()

  const inputClass = "w-full px-4 py-3.5 rounded-[14px] border border-white/[0.08] bg-surface text-text text-[15px] outline-none transition-all duration-200 placeholder:text-text-3/50 focus-glow"

  return (
    <BottomSheet open={open} onClose={onClose} wide>
      <div className="mb-10">
        <h2 className="font-display text-[28px] font-700 tracking-[-0.03em] mb-2">
          {isBuiltin ? editing?.name : editing ? 'Edit Provider' : 'New Provider'}
        </h2>
        <p className="text-[14px] text-text-3">
          {isBuiltin ? 'Manage models and API key for this built-in provider' : 'Add an OpenAI-compatible provider (OpenRouter, Together, Groq, etc.)'}
        </p>
      </div>

      {/* Name */}
      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Name</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. OpenRouter"
          disabled={isBuiltin} className={`${inputClass} ${isBuiltin ? 'opacity-50' : ''}`} style={{ fontFamily: 'inherit' }} />
      </div>

      {/* Base URL — for custom providers and built-ins with endpoints (Ollama, OpenClaw) */}
      {(!isBuiltin || editingBuiltin?.requiresEndpoint) && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">
            {isBuiltin ? 'Endpoint' : 'Base URL'}
          </label>
          <input type="text" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={editingBuiltin?.defaultEndpoint || 'https://openrouter.ai/api/v1'}
            className={`${inputClass} font-mono text-[14px]`} />
          <p className="text-[11px] text-text-3/70 mt-2">
            {isBuiltin ? `Default: ${editingBuiltin?.defaultEndpoint || 'none'}` : 'OpenAI-compatible API endpoint (without /chat/completions)'}
          </p>
        </div>
      )}

      {/* Models — chip editor for built-in, textarea for custom */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em]">Models</label>
          <div className="flex items-center gap-3">
            {canDiscoverModels && (
              <button
                onClick={() => { void handleLoadLiveModels(Boolean(liveModels.length)) }}
                disabled={liveLoading}
                className="text-[11px] text-accent-bright hover:brightness-110 transition-colors cursor-pointer bg-transparent border-none disabled:opacity-50 disabled:cursor-default"
                style={{ fontFamily: 'inherit' }}
              >
                {liveLoading ? 'Loading live models...' : liveModels.length > 0 ? 'Refresh live list' : 'Load live models'}
              </button>
            )}
            {isBuiltin && (
              <button onClick={handleResetModels}
                className="text-[11px] text-text-3 hover:text-text-2 transition-colors cursor-pointer bg-transparent border-none"
                style={{ fontFamily: 'inherit' }}>
                Reset to defaults
              </button>
            )}
          </div>
        </div>

        {(liveMessage || liveCached) && (
          <p className="text-[11px] text-text-3/70 mb-3">
            {liveMessage}
            {liveCached ? ' Cached.' : ''}
          </p>
        )}

        {isBuiltin ? (
          <>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {modelList.map((model, i) => {
                const isLive = liveModels.includes(model)
                return (
                  <div key={`${model}-${i}`} className={`group/model flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] border
                    ${isLive ? 'bg-emerald-500/[0.08] border-emerald-500/20' : 'bg-white/[0.04] border-white/[0.06]'}`}>
                    <span className="text-[12px] text-text-2 font-mono">{model}</span>
                    {isLive && (
                      <span className="text-[9px] font-600 px-1.5 py-0.5 rounded-[4px] bg-emerald-500/15 text-emerald-400 uppercase tracking-wider">live</span>
                    )}
                    <button
                      onClick={() => handleRemoveModel(i)}
                      className="w-4 h-4 rounded-full flex items-center justify-center text-[9px] text-text-3
                        opacity-0 group-hover/model:opacity-100 hover:bg-red-500/20 hover:text-red-400
                        transition-all cursor-pointer bg-transparent border-none"
                    >
                      &times;
                    </button>
                  </div>
                )
              })}
            </div>

            <div className="flex gap-2">
              <input
                type="text"
                value={newModel}
                onChange={(e) => setNewModel(e.target.value)}
                placeholder="Add model ID..."
                className={`${inputClass} flex-1 font-mono text-[14px]`}
                style={{ fontFamily: 'inherit' }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddModel() } }}
              />
              <button
                onClick={handleAddModel}
                disabled={!newModel.trim()}
                className="px-4 py-3 rounded-[14px] border-none bg-accent-soft text-accent-bright text-[13px] font-600
                  cursor-pointer disabled:opacity-30 hover:brightness-110 transition-all shrink-0"
                style={{ fontFamily: 'inherit' }}
              >
                Add
              </button>
            </div>
          </>
        ) : (
          <>
            <textarea
              value={models}
              onChange={(e) => setModels(e.target.value)}
              placeholder="model-1, model-2, model-3"
              rows={3}
              className={`${inputClass} resize-y min-h-[80px] font-mono text-[14px]`}
              style={{ fontFamily: 'inherit' }}
            />
            <p className="text-[11px] text-text-3/70 mt-2">Comma-separated model IDs</p>
          </>
        )}
      </div>

      {/* Requires API Key toggle — only for custom */}
      {!isBuiltin && (
        <div className="mb-8">
          <label className="flex items-center gap-3 cursor-pointer">
            <div
              onClick={() => setRequiresApiKey(!requiresApiKey)}
              className={`w-11 h-6 rounded-full transition-all duration-200 relative cursor-pointer
                ${requiresApiKey ? 'bg-accent-bright' : 'bg-white/[0.08]'}`}
            >
              <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200
                ${requiresApiKey ? 'left-[22px]' : 'left-0.5'}`} />
            </div>
            <span className="font-display text-[14px] font-600 text-text-2">Requires API Key</span>
          </label>
        </div>
      )}

      {/* API Key section */}
      {showApiKey && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">
            {isBuiltin ? 'API Key' : 'Linked API Key'}
            {isBuiltin && editingBuiltin?.optionalApiKey && !editingBuiltin?.requiresApiKey && (
              <span className="normal-case tracking-normal font-normal text-text-3 ml-1">(optional)</span>
            )}
          </label>
          {credList.length > 0 && !addingKey ? (
            <div className="flex gap-2">
              <select value={credentialId || ''} onChange={(e) => {
                if (e.target.value === '__add__') {
                  setAddingKey(true)
                  setNewKeyName('')
                  setNewKeyValue('')
                } else {
                  setCredentialId(e.target.value || null)
                }
              }} className={`${inputClass} appearance-none cursor-pointer flex-1`} style={{ fontFamily: 'inherit' }}>
                <option value="">Select a key...</option>
                {credList.map((c) => (
                  <option key={c.id} value={c.id}>{c.name} ({c.provider})</option>
                ))}
                <option value="__add__">+ Add new key...</option>
              </select>
              <button
                type="button"
                onClick={() => { setAddingKey(true); setNewKeyName(''); setNewKeyValue('') }}
                className="shrink-0 px-3 py-2.5 rounded-[10px] bg-accent-soft/50 text-accent-bright text-[12px] font-600 hover:bg-accent-soft transition-colors cursor-pointer border border-accent-bright/20"
              >
                + New
              </button>
            </div>
          ) : (
            <div className="space-y-3 p-4 rounded-[12px] border border-accent-bright/15 bg-accent-soft/20">
              <input
                type="text"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                placeholder="Key name (optional)"
                className={inputClass}
                style={{ fontFamily: 'inherit' }}
              />
              <input
                type="password"
                value={newKeyValue}
                onChange={(e) => setNewKeyValue(e.target.value)}
                placeholder="Paste API key..."
                className={inputClass}
                style={{ fontFamily: 'inherit' }}
              />
              <div className="flex gap-2 justify-end">
                {credList.length > 0 && (
                  <button type="button" onClick={() => setAddingKey(false)} className="px-3 py-1.5 text-[12px] text-text-3 hover:text-text-2 transition-colors cursor-pointer bg-transparent border-none" style={{ fontFamily: 'inherit' }}>Cancel</button>
                )}
                <button
                  type="button"
                  disabled={savingKey || !newKeyValue.trim()}
                  onClick={async () => {
                    setSavingKey(true)
                    try {
                      const cred = await api<{ id: string }>('POST', '/credentials', { provider: editingId || name || 'custom', name: newKeyName.trim() || `${name || editingId || 'Custom'} key`, apiKey: newKeyValue.trim() })
                      await loadCredentials()
                      setCredentialId(cred.id)
                      setAddingKey(false)
                      setNewKeyName('')
                      setNewKeyValue('')
                    } catch (err: unknown) { toast.error(`Failed to save: ${errorMessage(err)}`) }
                    finally { setSavingKey(false) }
                  }}
                  className="px-4 py-1.5 rounded-[8px] bg-accent-bright text-white text-[12px] font-600 cursor-pointer border-none hover:brightness-110 transition-all disabled:opacity-40"
                  style={{ fontFamily: 'inherit' }}
                >
                  {savingKey ? 'Saving...' : 'Save Key'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Enabled toggle — only for custom */}
      {!isBuiltin && editingCustom && (
        <div className="mb-8">
          <label className="flex items-center gap-3 cursor-pointer">
            <div
              onClick={() => setIsEnabled(!isEnabled)}
              className={`w-11 h-6 rounded-full transition-all duration-200 relative cursor-pointer
                ${isEnabled ? 'bg-accent-bright' : 'bg-white/[0.08]'}`}
            >
              <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200
                ${isEnabled ? 'left-[22px]' : 'left-0.5'}`} />
            </div>
            <span className="font-display text-[14px] font-600 text-text-2">Enabled</span>
          </label>
        </div>
      )}

      {/* Test connection result */}
      {testStatus === 'fail' && (
        <div className="mb-4 p-3 rounded-[12px] bg-red-500/[0.08] border border-red-500/20">
          <p className="text-[13px] text-red-400">{testMessage || 'Connection test failed'}</p>
        </div>
      )}
      {testStatus === 'pass' && (
        <div className="mb-4 p-3 rounded-[12px] bg-emerald-500/[0.08] border border-emerald-500/20">
          <p className="text-[13px] text-emerald-400">{testMessage || 'Connected successfully'}</p>
        </div>
      )}

      <div className="flex gap-3 pt-2 border-t border-white/[0.04]">
        {editingCustom && (
          <button onClick={() => setConfirmDelete(true)} className="py-3.5 px-6 rounded-[14px] border border-red-500/20 bg-transparent text-red-400 text-[15px] font-600 cursor-pointer hover:bg-red-500/10 transition-all" style={{ fontFamily: 'inherit' }}>
            Delete
          </button>
        )}
        <button onClick={onClose} className="flex-1 py-3.5 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[15px] font-600 cursor-pointer hover:bg-surface-2 transition-all" style={{ fontFamily: 'inherit' }}>
          Cancel
        </button>
        {showApiKey && credentialId && testStatus !== 'pass' ? (
          <button
            onClick={handleTestConnection}
            disabled={testStatus === 'testing'}
            className="flex-1 py-3.5 rounded-[14px] border-none bg-emerald-600 text-white text-[15px] font-600 cursor-pointer active:scale-[0.97] disabled:opacity-30 transition-all shadow-[0_4px_20px_rgba(16,185,129,0.2)] hover:brightness-110"
            style={{ fontFamily: 'inherit' }}
          >
            {testStatus === 'testing' ? 'Testing...' : testStatus === 'fail' ? 'Retry Connection' : 'Test Connection'}
          </button>
        ) : (
          <button
            onClick={handleSave}
            disabled={isBuiltin ? false : (!name.trim() || !baseUrl.trim())}
            className="flex-1 py-3.5 rounded-[14px] border-none bg-accent-bright text-white text-[15px] font-600 cursor-pointer active:scale-[0.97] disabled:opacity-30 transition-all shadow-[0_4px_20px_rgba(99,102,241,0.25)] hover:brightness-110"
            style={{ fontFamily: 'inherit' }}
          >
            {editing ? 'Save' : 'Create'}
          </button>
        )}
      </div>
      <ConfirmDialog
        open={confirmDelete}
        title="Delete Provider?"
        message={editingCustom ? `Delete custom provider "${editingCustom.name}"?` : 'Delete this provider?'}
        confirmLabel={deleting ? 'Deleting...' : 'Delete'}
        confirmDisabled={deleting}
        cancelDisabled={deleting}
        danger
        onConfirm={() => { void handleDelete() }}
        onCancel={() => { if (!deleting) setConfirmDelete(false) }}
      />
    </BottomSheet>
  )
}
