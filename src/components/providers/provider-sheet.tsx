'use client'

import { useEffect, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { createProviderConfig, updateProviderConfig, deleteProviderConfig } from '@/lib/provider-config'
import { api } from '@/lib/api-client'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import { AiGenBlock } from '@/components/shared/ai-gen-block'

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

  // Ollama local models
  const [localModels, setLocalModels] = useState<string[]>([])
  const [localLoading, setLocalLoading] = useState(false)
  const [localError, setLocalError] = useState('')

  // AI generation state
  const [aiPrompt, setAiPrompt] = useState('')
  const [generating, setGenerating] = useState(false)
  const [generated, setGenerated] = useState(false)
  const [genError, setGenError] = useState('')
  const appSettings = useAppStore((s) => s.appSettings)
  const loadSettings = useAppStore((s) => s.loadSettings)

  // Find editing provider in custom configs OR built-in list
  const editingCustom = editingId ? providerConfigs.find((c) => c.id === editingId) : null
  const editingBuiltin = editingId ? providers.find((p) => p.id === editingId) : null
  const isBuiltin = !!editingBuiltin && !editingCustom
  const editing = editingCustom || editingBuiltin

  const handleGenerate = async () => {
    if (!aiPrompt.trim()) return
    setGenerating(true)
    setGenError('')
    try {
      const result = await api<{ name?: string; baseUrl?: string; models?: string; requiresApiKey?: boolean; error?: string }>('POST', '/generate', { type: 'provider', prompt: aiPrompt })
      if (result.error) {
        setGenError(result.error)
      } else if (result.name || result.baseUrl) {
        if (result.name) setName(result.name)
        if (result.baseUrl) setBaseUrl(result.baseUrl)
        if (result.models) setModels(result.models)
        if (result.requiresApiKey !== undefined) setRequiresApiKey(result.requiresApiKey)
        setGenerated(true)
      } else {
        setGenError('AI returned empty response — try again')
      }
    } catch (err: unknown) {
      setGenError(err instanceof Error ? err.message : 'Generation failed')
    }
    setGenerating(false)
  }

  useEffect(() => {
    if (open) {
      loadCredentials()
      loadSettings()
      setAiPrompt('')
      setGenerating(false)
      setGenerated(false)
      setGenError('')
      setNewModel('')
      setLocalModels([])
      setLocalError('')
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
  }, [open, editingId])

  // Fetch local Ollama models when editing Ollama provider
  useEffect(() => {
    if (!open || editingId !== 'ollama') return
    setLocalLoading(true)
    const endpoint = baseUrl || 'http://localhost:11434'
    api<{ models: { name: string }[]; error?: string }>('GET', `/providers/ollama?endpoint=${encodeURIComponent(endpoint)}`)
      .then((res) => {
        if (res.error) {
          setLocalError(res.error)
          setLocalModels([])
        } else {
          setLocalModels(res.models.map((m) => m.name))
        }
      })
      .catch(() => {
        setLocalError('Failed to connect')
        setLocalModels([])
      })
      .finally(() => setLocalLoading(false))
  }, [open, editingId, baseUrl])

  const onClose = () => {
    setOpen(false)
    setEditingId(null)
  }

  const handleSave = async () => {
    if (isBuiltin) {
      // Save model overrides for built-in providers
      const modelList = models.split(',').map((m) => m.trim()).filter(Boolean)
      await api('PUT', `/providers/${editingId}/models`, { models: modelList })
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
    } else {
      await createProviderConfig(data)
    }
    await loadProviderConfigs()
    onClose()
  }

  const handleDelete = async () => {
    if (editingCustom) {
      await deleteProviderConfig(editingCustom.id)
      await loadProviderConfigs()
      onClose()
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

  const credList = Object.values(credentials)
  const modelList = models.split(',').map((m) => m.trim()).filter(Boolean)
  const isNew = !editing
  const showApiKey = isBuiltin ? editingBuiltin?.requiresApiKey || editingBuiltin?.optionalApiKey : requiresApiKey

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

      {/* AI Generation — only for new custom providers */}
      {isNew && <AiGenBlock
        aiPrompt={aiPrompt} setAiPrompt={setAiPrompt}
        generating={generating} generated={generated} genError={genError}
        onGenerate={handleGenerate} appSettings={appSettings}
        placeholder='Name a provider, e.g. "Groq", "Together AI", "z.ai", "DeepSeek"'
      />}

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
          {isBuiltin && (
            <button onClick={handleResetModels}
              className="text-[11px] text-text-3 hover:text-text-2 transition-colors cursor-pointer bg-transparent border-none"
              style={{ fontFamily: 'inherit' }}>
              Reset to defaults
            </button>
          )}
        </div>

        {isBuiltin ? (
          <>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {modelList.map((model, i) => {
                const isLocal = editingId === 'ollama' && localModels.includes(model)
                return (
                  <div key={`${model}-${i}`} className={`group/model flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] border
                    ${isLocal ? 'bg-emerald-500/[0.08] border-emerald-500/20' : 'bg-white/[0.04] border-white/[0.06]'}`}>
                    <span className="text-[12px] text-text-2 font-mono">{model}</span>
                    {isLocal && (
                      <span className="text-[9px] font-600 px-1.5 py-0.5 rounded-[4px] bg-emerald-500/15 text-emerald-400 uppercase tracking-wider">local</span>
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

            {/* Ollama: show available local models not yet in the list */}
            {editingId === 'ollama' && !localLoading && localModels.length > 0 && (() => {
              const missing = localModels.filter((m) => !modelList.includes(m))
              if (missing.length === 0) return null
              return (
                <div className="mb-3">
                  <p className="text-[11px] text-text-3/60 mb-2">Available locally — click to add:</p>
                  <div className="flex flex-wrap gap-1.5">
                    {missing.map((m) => (
                      <button key={m} onClick={() => { setModels(models ? models + ', ' + m : m) }}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] bg-emerald-500/[0.05] border border-emerald-500/15
                          hover:bg-emerald-500/10 transition-all cursor-pointer text-[12px] text-emerald-300/80 font-mono"
                        style={{ fontFamily: 'inherit' }}>
                        <span>+</span> {m}
                      </button>
                    ))}
                  </div>
                </div>
              )
            })()}

            {editingId === 'ollama' && localLoading && (
              <p className="text-[11px] text-text-3/70 mb-3">Checking local Ollama instance...</p>
            )}
            {editingId === 'ollama' && localError && (
              <p className="text-[11px] text-amber-400/60 mb-3">{localError}</p>
            )}

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
                ${requiresApiKey ? 'bg-[#6366F1]' : 'bg-white/[0.08]'}`}
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
                      const cred = await api<any>('POST', '/credentials', { provider: editingId || name || 'custom', name: newKeyName.trim() || `${name || editingId || 'Custom'} key`, apiKey: newKeyValue.trim() })
                      await loadCredentials()
                      setCredentialId(cred.id)
                      setAddingKey(false)
                      setNewKeyName('')
                      setNewKeyValue('')
                    } catch (err: any) { alert(`Failed to save: ${err.message}`) }
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
                ${isEnabled ? 'bg-[#6366F1]' : 'bg-white/[0.08]'}`}
            >
              <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200
                ${isEnabled ? 'left-[22px]' : 'left-0.5'}`} />
            </div>
            <span className="font-display text-[14px] font-600 text-text-2">Enabled</span>
          </label>
        </div>
      )}

      <div className="flex gap-3 pt-2 border-t border-white/[0.04]">
        {editingCustom && (
          <button onClick={handleDelete} className="py-3.5 px-6 rounded-[14px] border border-red-500/20 bg-transparent text-red-400 text-[15px] font-600 cursor-pointer hover:bg-red-500/10 transition-all" style={{ fontFamily: 'inherit' }}>
            Delete
          </button>
        )}
        <button onClick={onClose} className="flex-1 py-3.5 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[15px] font-600 cursor-pointer hover:bg-surface-2 transition-all" style={{ fontFamily: 'inherit' }}>
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={isBuiltin ? false : (!name.trim() || !baseUrl.trim())}
          className="flex-1 py-3.5 rounded-[14px] border-none bg-[#6366F1] text-white text-[15px] font-600 cursor-pointer active:scale-[0.97] disabled:opacity-30 transition-all shadow-[0_4px_20px_rgba(99,102,241,0.25)] hover:brightness-110"
          style={{ fontFamily: 'inherit' }}
        >
          {editing ? 'Save' : 'Create'}
        </button>
      </div>
    </BottomSheet>
  )
}
