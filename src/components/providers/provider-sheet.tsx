'use client'

import { useEffect, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { createProviderConfig, updateProviderConfig, deleteProviderConfig } from '@/lib/provider-config'
import { BottomSheet } from '@/components/shared/bottom-sheet'

export function ProviderSheet() {
  const open = useAppStore((s) => s.providerSheetOpen)
  const setOpen = useAppStore((s) => s.setProviderSheetOpen)
  const editingId = useAppStore((s) => s.editingProviderId)
  const setEditingId = useAppStore((s) => s.setEditingProviderId)
  const providerConfigs = useAppStore((s) => s.providerConfigs)
  const loadProviderConfigs = useAppStore((s) => s.loadProviderConfigs)
  const credentials = useAppStore((s) => s.credentials)
  const loadCredentials = useAppStore((s) => s.loadCredentials)

  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [models, setModels] = useState('')
  const [requiresApiKey, setRequiresApiKey] = useState(true)
  const [credentialId, setCredentialId] = useState<string | null>(null)
  const [isEnabled, setIsEnabled] = useState(true)

  const editing = editingId ? providerConfigs.find((c) => c.id === editingId) : null

  useEffect(() => {
    if (open) {
      loadCredentials()
      if (editing) {
        setName(editing.name)
        setBaseUrl(editing.baseUrl || '')
        setModels(editing.models.join(', '))
        setRequiresApiKey(editing.requiresApiKey)
        setCredentialId(editing.credentialId || null)
        setIsEnabled(editing.isEnabled)
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

  const onClose = () => {
    setOpen(false)
    setEditingId(null)
  }

  const handleSave = async () => {
    const modelList = models.split(',').map((m) => m.trim()).filter(Boolean)
    const data = {
      name: name.trim() || 'Custom Provider',
      baseUrl: baseUrl.trim(),
      models: modelList,
      requiresApiKey,
      credentialId,
      isEnabled,
    }
    if (editing) {
      await updateProviderConfig(editing.id, data)
    } else {
      await createProviderConfig(data)
    }
    await loadProviderConfigs()
    onClose()
  }

  const handleDelete = async () => {
    if (editing) {
      await deleteProviderConfig(editing.id)
      await loadProviderConfigs()
      onClose()
    }
  }

  const credList = Object.values(credentials)

  const inputClass = "w-full px-4 py-3.5 rounded-[14px] border border-white/[0.08] bg-surface text-text text-[15px] outline-none transition-all duration-200 placeholder:text-text-3/50 focus-glow"

  return (
    <BottomSheet open={open} onClose={onClose} wide>
      <div className="mb-10">
        <h2 className="font-display text-[28px] font-700 tracking-[-0.03em] mb-2">
          {editing ? 'Edit Provider' : 'New Provider'}
        </h2>
        <p className="text-[14px] text-text-3">Add an OpenAI-compatible provider (OpenRouter, Together, Groq, etc.)</p>
      </div>

      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Name</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. OpenRouter" className={inputClass} style={{ fontFamily: 'inherit' }} />
      </div>

      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Base URL</label>
        <input type="text" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://openrouter.ai/api/v1" className={`${inputClass} font-mono text-[14px]`} />
        <p className="text-[11px] text-text-3/40 mt-2">OpenAI-compatible API endpoint (without /chat/completions)</p>
      </div>

      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Models</label>
        <textarea
          value={models}
          onChange={(e) => setModels(e.target.value)}
          placeholder="model-1, model-2, model-3"
          rows={3}
          className={`${inputClass} resize-y min-h-[80px] font-mono text-[14px]`}
          style={{ fontFamily: 'inherit' }}
        />
        <p className="text-[11px] text-text-3/40 mt-2">Comma-separated model IDs</p>
      </div>

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

      {requiresApiKey && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Linked API Key</label>
          <select value={credentialId || ''} onChange={(e) => setCredentialId(e.target.value || null)} className={`${inputClass} appearance-none cursor-pointer`} style={{ fontFamily: 'inherit' }}>
            <option value="">Select a key...</option>
            {credList.map((c) => (
              <option key={c.id} value={c.id}>{c.name} ({c.provider})</option>
            ))}
          </select>
          <p className="text-[11px] text-text-3/40 mt-2">Add API keys in Settings first, then link here</p>
        </div>
      )}

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

      <div className="flex gap-3 pt-2 border-t border-white/[0.04]">
        {editing && (
          <button onClick={handleDelete} className="py-3.5 px-6 rounded-[14px] border border-red-500/20 bg-transparent text-red-400 text-[15px] font-600 cursor-pointer hover:bg-red-500/10 transition-all" style={{ fontFamily: 'inherit' }}>
            Delete
          </button>
        )}
        <button onClick={onClose} className="flex-1 py-3.5 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[15px] font-600 cursor-pointer hover:bg-surface-2 transition-all" style={{ fontFamily: 'inherit' }}>
          Cancel
        </button>
        <button onClick={handleSave} disabled={!name.trim() || !baseUrl.trim()} className="flex-1 py-3.5 rounded-[14px] border-none bg-[#6366F1] text-white text-[15px] font-600 cursor-pointer active:scale-[0.97] disabled:opacity-30 transition-all shadow-[0_4px_20px_rgba(99,102,241,0.25)] hover:brightness-110" style={{ fontFamily: 'inherit' }}>
          {editing ? 'Save' : 'Create'}
        </button>
      </div>
    </BottomSheet>
  )
}
