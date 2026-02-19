'use client'

import { useEffect, useState, useCallback } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { createCredential, deleteCredential } from '@/lib/sessions'
import { BottomSheet } from './bottom-sheet'
import { api } from '@/lib/api-client'
import type { ProviderType, LangGraphProvider, OrchestratorSecret, PluginMeta } from '@/types'

const LG_PROVIDERS: { id: LangGraphProvider; name: string }[] = [
  { id: 'anthropic', name: 'Anthropic' },
  { id: 'openai', name: 'OpenAI' },
  { id: 'ollama', name: 'Ollama' },
]

export function SettingsSheet() {
  const open = useAppStore((s) => s.settingsOpen)
  const setOpen = useAppStore((s) => s.setSettingsOpen)
  const providers = useAppStore((s) => s.providers)
  const credentials = useAppStore((s) => s.credentials)
  const loadProviders = useAppStore((s) => s.loadProviders)
  const loadCredentials = useAppStore((s) => s.loadCredentials)
  const appSettings = useAppStore((s) => s.appSettings)
  const loadSettings = useAppStore((s) => s.loadSettings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const secrets = useAppStore((s) => s.secrets)
  const loadSecrets = useAppStore((s) => s.loadSecrets)
  const agents = useAppStore((s) => s.agents)
  const loadAgents = useAppStore((s) => s.loadAgents)

  const [addProvider, setAddProvider] = useState<ProviderType | null>(null)
  const [newName, setNewName] = useState('')
  const [newKey, setNewKey] = useState('')
  const [deleting, setDeleting] = useState<string | null>(null)

  // Secrets form state
  const [addingSecret, setAddingSecret] = useState(false)
  const [secretName, setSecretName] = useState('')
  const [secretService, setSecretService] = useState('')
  const [secretValue, setSecretValue] = useState('')
  const [secretScope, setSecretScope] = useState<'global' | 'agent'>('global')
  const [secretAgentIds, setSecretAgentIds] = useState<string[]>([])
  const [deletingSecret, setDeletingSecret] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      loadProviders()
      loadCredentials()
      loadSettings()
      loadSecrets()
      loadAgents()
      setAddProvider(null)
      setNewName('')
      setNewKey('')
      setDeleting(null)
      setAddingSecret(false)
      setDeletingSecret(null)
    }
  }, [open])

  const credList = Object.values(credentials)

  const handleAdd = async () => {
    if (!addProvider || !newKey.trim()) return
    await createCredential(addProvider, newName || `${addProvider} key`, newKey)
    await loadCredentials()
    setAddProvider(null)
    setNewName('')
    setNewKey('')
  }

  const handleDelete = async (id: string) => {
    await deleteCredential(id)
    await loadCredentials()
    setDeleting(null)
  }

  const handleAddSecret = async () => {
    if (!secretName.trim() || !secretValue.trim()) return
    await api('POST', '/secrets', {
      name: secretName,
      service: secretService || 'custom',
      value: secretValue,
      scope: secretScope,
      agentIds: secretScope === 'agent' ? secretAgentIds : [],
    })
    await loadSecrets()
    setAddingSecret(false)
    setSecretName('')
    setSecretService('')
    setSecretValue('')
    setSecretScope('global')
    setSecretAgentIds([])
  }

  const handleDeleteSecret = async (id: string) => {
    await api('DELETE', `/secrets/${id}`)
    await loadSecrets()
    setDeletingSecret(null)
  }

  const orchestrators = Object.values(agents).filter((p) => p.isOrchestrator)
  const secretList = Object.values(secrets)

  // LangGraph config
  const lgProvider = appSettings.langGraphProvider || 'anthropic'
  const lgProviderInfo = providers.find((p) => p.id === lgProvider)
  const lgCredentials = credList.filter((c) => c.provider === lgProvider)

  const inputClass = "w-full px-4 py-3.5 rounded-[14px] border border-white/[0.08] bg-bg text-text text-[15px] outline-none transition-all duration-200 placeholder:text-text-3/50 focus-glow"

  return (
    <BottomSheet open={open} onClose={() => setOpen(false)} wide>
      {/* Header */}
      <div className="mb-10">
        <h2 className="font-display text-[28px] font-700 tracking-[-0.03em] mb-2">Settings</h2>
        <p className="text-[14px] text-text-3">Manage providers, API keys & orchestrator engine</p>
      </div>

      {/* User Preferences (global system prompt) */}
      <div className="mb-10">
        <h3 className="font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
          User Preferences
        </h3>
        <p className="text-[12px] text-text-3 mb-5">
          Global instructions injected into ALL agent system prompts. Define your style, rules, and preferences.
        </p>
        <textarea
          value={appSettings.userPrompt || ''}
          onChange={(e) => updateSettings({ userPrompt: e.target.value })}
          placeholder="e.g. Always respond concisely. Use TypeScript over JavaScript. Prefer functional patterns. My timezone is PST."
          rows={4}
          className={`${inputClass} resize-y min-h-[100px]`}
          style={{ fontFamily: 'inherit' }}
        />
      </div>

      {/* LangGraph Orchestrator Engine */}
      <div className="mb-10">
        <h3 className="font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
          Orchestrator Engine
        </h3>
        <p className="text-[12px] text-text-3 mb-5">
          The LLM provider used by orchestrators for tool calling, agent generation, and task delegation.
        </p>

        <div className="p-6 rounded-[18px] bg-surface border border-white/[0.06]">
          {/* Provider picker */}
          <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-3">Provider</label>
          <div className="grid grid-cols-3 gap-2 mb-5">
            {LG_PROVIDERS.map((p) => (
              <button
                key={p.id}
                onClick={() => updateSettings({ langGraphProvider: p.id, langGraphModel: '', langGraphCredentialId: null })}
                className={`py-3 px-3 rounded-[12px] text-center cursor-pointer transition-all text-[13px] font-600 border
                  ${lgProvider === p.id
                    ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
                    : 'bg-bg border-white/[0.06] text-text-2 hover:bg-surface-2'}`}
                style={{ fontFamily: 'inherit' }}
              >
                {p.name}
              </button>
            ))}
          </div>

          {/* Model picker */}
          {lgProviderInfo && lgProviderInfo.models.length > 0 && (
            <div className="mb-5">
              <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-3">Model</label>
              <select
                value={appSettings.langGraphModel || lgProviderInfo.models[0]}
                onChange={(e) => updateSettings({ langGraphModel: e.target.value })}
                className={`${inputClass} appearance-none cursor-pointer`}
                style={{ fontFamily: 'inherit' }}
              >
                {lgProviderInfo.models.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
          )}

          {/* API Key picker */}
          <div>
            <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-3">API Key</label>
            {lgCredentials.length > 0 ? (
              <select
                value={appSettings.langGraphCredentialId || ''}
                onChange={(e) => updateSettings({ langGraphCredentialId: e.target.value || null })}
                className={`${inputClass} appearance-none cursor-pointer`}
                style={{ fontFamily: 'inherit' }}
              >
                <option value="">Select a key...</option>
                {lgCredentials.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            ) : (
              <p className="text-[12px] text-text-3/60">
                No {lgProvider} API keys configured. Add one below in the Providers section.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Embedding Config */}
      <div className="mb-10">
        <h3 className="font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
          Embeddings
        </h3>
        <p className="text-[12px] text-text-3 mb-5">
          Enable semantic search for agent memory. Requires an embedding model provider.
        </p>
        <div className="p-6 rounded-[18px] bg-surface border border-white/[0.06]">
          <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-3">Provider</label>
          <div className="grid grid-cols-4 gap-2 mb-5">
            {[
              { id: null, name: 'Off' },
              { id: 'local' as const, name: 'Local (Free)' },
              { id: 'openai' as const, name: 'OpenAI' },
              { id: 'ollama' as const, name: 'Ollama' },
            ].map((p) => (
              <button
                key={String(p.id)}
                onClick={() => updateSettings({ embeddingProvider: p.id, embeddingModel: null, embeddingCredentialId: null })}
                className={`py-3 px-3 rounded-[12px] text-center cursor-pointer transition-all text-[13px] font-600 border
                  ${(appSettings.embeddingProvider || null) === p.id
                    ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
                    : 'bg-bg border-white/[0.06] text-text-2 hover:bg-surface-2'}`}
                style={{ fontFamily: 'inherit' }}
              >
                {p.name}
              </button>
            ))}
          </div>

          {appSettings.embeddingProvider === 'local' && (
            <p className="text-[12px] text-text-3/80 mb-5">
              Runs <span className="text-text-2 font-600">all-MiniLM-L6-v2</span> locally in Node.js — no API key, no cost, works offline. Model downloads once (~23MB).
            </p>
          )}

          {appSettings.embeddingProvider === 'openai' && (
            <>
              <div className="mb-5">
                <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-3">Model</label>
                <select
                  value={appSettings.embeddingModel || 'text-embedding-3-small'}
                  onChange={(e) => updateSettings({ embeddingModel: e.target.value })}
                  className={`${inputClass} appearance-none cursor-pointer`}
                  style={{ fontFamily: 'inherit' }}
                >
                  <option value="text-embedding-3-small">text-embedding-3-small</option>
                  <option value="text-embedding-3-large">text-embedding-3-large</option>
                </select>
              </div>
              <div>
                <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-3">API Key</label>
                {credList.filter((c) => c.provider === 'openai').length > 0 ? (
                  <select
                    value={appSettings.embeddingCredentialId || ''}
                    onChange={(e) => updateSettings({ embeddingCredentialId: e.target.value || null })}
                    className={`${inputClass} appearance-none cursor-pointer`}
                    style={{ fontFamily: 'inherit' }}
                  >
                    <option value="">Select a key...</option>
                    {credList.filter((c) => c.provider === 'openai').map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                ) : (
                  <p className="text-[12px] text-text-3/60">No OpenAI API keys configured.</p>
                )}
              </div>
            </>
          )}

          {appSettings.embeddingProvider === 'ollama' && (
            <div>
              <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-3">Model</label>
              <input
                type="text"
                value={appSettings.embeddingModel || 'nomic-embed-text'}
                onChange={(e) => updateSettings({ embeddingModel: e.target.value })}
                placeholder="nomic-embed-text"
                className={inputClass}
                style={{ fontFamily: 'inherit' }}
              />
              <p className="text-[11px] text-text-3/60 mt-2">Uses your local Ollama instance for embeddings</p>
            </div>
          )}
        </div>
      </div>

      {/* Orchestrator Secrets */}
      <div className="mb-10">
        <h3 className="font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
          Service Credentials
        </h3>
        <p className="text-[12px] text-text-3 mb-5">
          Credentials for external services (Gmail, APIs, etc.) that orchestrators can use during task execution.
        </p>

        {secretList.length > 0 && (
          <div className="space-y-2.5 mb-4">
            {secretList.map((secret) => (
              <div key={secret.id} className="flex items-center gap-3 py-3 px-4 rounded-[14px] bg-surface border border-white/[0.06]">
                <div className="flex-1 min-w-0">
                  <div className="text-[14px] font-600 text-text truncate">{secret.name}</div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[11px] font-mono text-text-3">{secret.service}</span>
                    <span className={`text-[10px] font-600 px-1.5 py-0.5 rounded-[4px] ${
                      secret.scope === 'global'
                        ? 'bg-emerald-500/10 text-emerald-400'
                        : 'bg-amber-500/10 text-amber-400'
                    }`}>
                      {secret.scope === 'global' ? 'All orchestrators' : `${secret.agentIds.length} orchestrator(s)`}
                    </span>
                  </div>
                </div>
                {deletingSecret === secret.id ? (
                  <div className="flex gap-2">
                    <button onClick={() => setDeletingSecret(null)} className="px-3 py-1.5 text-[13px] font-600 bg-transparent border-none text-text-3 cursor-pointer hover:text-text-2 transition-colors" style={{ fontFamily: 'inherit' }}>Keep</button>
                    <button onClick={() => handleDeleteSecret(secret.id)} className="px-3 py-1.5 text-[13px] font-600 bg-danger text-white border-none cursor-pointer rounded-[8px] transition-colors hover:brightness-110" style={{ fontFamily: 'inherit' }}>Delete</button>
                  </div>
                ) : (
                  <button onClick={() => setDeletingSecret(secret.id)} className="px-3 py-1.5 text-[13px] font-500 bg-transparent border-none text-text-3 cursor-pointer hover:text-danger transition-colors" style={{ fontFamily: 'inherit' }}>Remove</button>
                )}
              </div>
            ))}
          </div>
        )}

        {addingSecret ? (
          <div className="p-6 rounded-[18px] bg-surface border border-white/[0.06] space-y-4">
            <div className="font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em]">New Secret</div>
            <input type="text" value={secretName} onChange={(e) => setSecretName(e.target.value)} placeholder="Name (e.g. My Gmail)" className={inputClass} style={{ fontFamily: 'inherit' }} />
            <input type="text" value={secretService} onChange={(e) => setSecretService(e.target.value)} placeholder="Service (e.g. gmail, ahrefs, custom)" className={inputClass} style={{ fontFamily: 'inherit' }} />
            <input type="password" value={secretValue} onChange={(e) => setSecretValue(e.target.value)} placeholder="Value (API key, password, token...)" className={inputClass} style={{ fontFamily: 'inherit' }} />

            <div>
              <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Scope</label>
              <div className="flex p-1 rounded-[12px] bg-bg border border-white/[0.06]">
                {(['global', 'agent'] as const).map((s) => (
                  <button key={s} onClick={() => setSecretScope(s)} className={`flex-1 py-2.5 rounded-[10px] text-center cursor-pointer transition-all text-[13px] font-600 capitalize ${secretScope === s ? 'bg-accent-soft text-accent-bright' : 'bg-transparent text-text-3 hover:text-text-2'}`} style={{ fontFamily: 'inherit' }}>{s === 'global' ? 'All Orchestrators' : 'Specific'}</button>
                ))}
              </div>
            </div>

            {secretScope === 'agent' && orchestrators.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {orchestrators.map((p) => (
                  <button key={p.id} onClick={() => setSecretAgentIds((prev) => prev.includes(p.id) ? prev.filter((x) => x !== p.id) : [...prev, p.id])} className={`px-3 py-2 rounded-[10px] text-[12px] font-600 cursor-pointer transition-all border ${secretAgentIds.includes(p.id) ? 'bg-accent-soft border-accent-bright/25 text-accent-bright' : 'bg-bg border-white/[0.06] text-text-3 hover:text-text-2'}`} style={{ fontFamily: 'inherit' }}>{p.name}</button>
                ))}
              </div>
            )}

            <div className="flex gap-3 pt-2">
              <button onClick={() => setAddingSecret(false)} className="flex-1 py-3 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[14px] font-600 cursor-pointer hover:bg-surface-2 transition-colors" style={{ fontFamily: 'inherit' }}>Cancel</button>
              <button onClick={handleAddSecret} disabled={!secretName.trim() || !secretValue.trim()} className="flex-1 py-3 rounded-[14px] border-none bg-[#6366F1] text-white text-[14px] font-600 cursor-pointer disabled:opacity-30 transition-all hover:brightness-110" style={{ fontFamily: 'inherit' }}>Save Secret</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setAddingSecret(true)} className="w-full py-3 rounded-[12px] border border-dashed border-white/[0.1] bg-transparent text-text-3 text-[13px] font-600 cursor-pointer hover:border-accent-bright/30 hover:text-accent-bright hover:bg-accent-soft transition-all duration-200" style={{ fontFamily: 'inherit' }}>+ Add Service Credential</button>
        )}
      </div>

      {/* Providers */}
      <div className="mb-8">
        <h3 className="font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-5">
          Providers
        </h3>
        <div className="space-y-4">
          {providers.map((p) => {
            const providerCreds = credList.filter((c) => c.provider === p.id)
            return (
              <div key={p.id} className="p-6 rounded-[18px] bg-surface border border-white/[0.06]">
                <div className="flex items-center justify-between mb-3">
                  <span className="font-display text-[17px] font-600 tracking-[-0.01em]">{p.name}</span>
                  <span className={`text-[12px] font-600 px-3 py-1 rounded-[8px]
                    ${p.requiresApiKey
                      ? providerCreds.length > 0 ? 'text-success bg-success/[0.1]' : 'text-text-3 bg-white/[0.04]'
                      : 'text-success bg-success/[0.1]'}`}>
                    {p.requiresApiKey
                      ? providerCreds.length > 0 ? 'Connected' : 'No key'
                      : p.optionalApiKey
                        ? providerCreds.length > 0 ? 'Local + Cloud' : 'Local'
                        : p.requiresEndpoint ? 'Local' : 'Built-in'}
                  </span>
                </div>
                <div className="text-[13px] text-text-2/50 font-mono">
                  {p.models.slice(0, 3).join(', ')}
                  {p.models.length > 3 && ` +${p.models.length - 3} more`}
                </div>

                {(p.requiresApiKey || p.optionalApiKey) && providerCreds.length > 0 && (
                  <div className="mt-5 space-y-2.5">
                    {providerCreds.map((cred) => (
                      <div key={cred.id} className="flex items-center gap-3 py-3 px-4 rounded-[12px] bg-bg border border-white/[0.06]">
                        <span className="text-[14px] font-500 flex-1 truncate">{cred.name}</span>
                        {deleting === cred.id ? (
                          <div className="flex gap-2">
                            <button
                              onClick={() => setDeleting(null)}
                              className="px-3 py-1.5 text-[13px] font-600 bg-transparent border-none text-text-3 cursor-pointer hover:text-text-2 transition-colors"
                              style={{ fontFamily: 'inherit' }}
                            >
                              Keep
                            </button>
                            <button
                              onClick={() => handleDelete(cred.id)}
                              className="px-3 py-1.5 text-[13px] font-600 bg-danger text-white border-none cursor-pointer rounded-[8px] transition-colors hover:brightness-110"
                              style={{ fontFamily: 'inherit' }}
                            >
                              Delete
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setDeleting(cred.id)}
                            className="px-3 py-1.5 text-[13px] font-500 bg-transparent border-none text-text-3 cursor-pointer hover:text-danger transition-colors"
                            style={{ fontFamily: 'inherit' }}
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {(p.requiresApiKey || p.optionalApiKey) && (
                  <button
                    onClick={() => setAddProvider(p.id)}
                    className="mt-5 w-full py-3 rounded-[12px] border border-dashed border-white/[0.1]
                      bg-transparent text-text-3 text-[13px] font-600 cursor-pointer
                      hover:border-accent-bright/30 hover:text-accent-bright hover:bg-accent-soft transition-all duration-200"
                    style={{ fontFamily: 'inherit' }}
                  >
                    + Add API Key{p.optionalApiKey && !p.requiresApiKey ? ' (for cloud)' : ''}
                  </button>
                )}

                {p.requiresEndpoint && (
                  <div className="mt-5 text-[13px] text-text-3/50 font-mono">
                    Endpoint: {(p as any).defaultEndpoint || 'http://localhost:11434'}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Add key form */}
      {addProvider && (
        <div className="mb-8 p-6 rounded-[18px] bg-surface border border-white/[0.06]">
          <div className="font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-4">
            New {providers.find((p) => p.id === addProvider)?.name} API Key
          </div>
          <div className="space-y-4">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Key name (optional)"
              className={inputClass}
              style={{ fontFamily: 'inherit' }}
            />
            <input
              type="password"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="sk-..."
              className={inputClass}
              style={{ fontFamily: 'inherit' }}
            />
            <div className="flex gap-3 pt-2">
              <button
                onClick={() => { setAddProvider(null); setNewName(''); setNewKey('') }}
                className="flex-1 py-3 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[14px] font-600 cursor-pointer hover:bg-surface-2 transition-colors"
                style={{ fontFamily: 'inherit' }}
              >
                Cancel
              </button>
              <button
                onClick={handleAdd}
                disabled={!newKey.trim()}
                className="flex-1 py-3 rounded-[14px] border-none bg-[#6366F1] text-white text-[14px] font-600 cursor-pointer disabled:opacity-30 transition-all hover:brightness-110"
                style={{ fontFamily: 'inherit' }}
              >
                Save Key
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Plugins */}
      <div className="mb-10">
        <h3 className="font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
          Plugins
        </h3>
        <p className="text-[12px] text-text-3 mb-5">
          Drop .js files into <code className="text-[11px] font-mono text-text-2">data/plugins/</code> to extend agent behavior with hooks.
        </p>
        <PluginList />
      </div>

      {/* Done */}
      <div className="pt-2 border-t border-white/[0.04]">
        <button
          onClick={() => setOpen(false)}
          className="w-full py-3.5 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[15px] font-600 cursor-pointer
            hover:bg-surface-2 transition-all duration-200"
          style={{ fontFamily: 'inherit' }}
        >
          Done
        </button>
      </div>
    </BottomSheet>
  )
}

function PluginList() {
  const [plugins, setPlugins] = useState<PluginMeta[]>([])
  const [loading, setLoading] = useState(false)

  const loadPlugins = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api<PluginMeta[]>('GET', '/plugins')
      setPlugins(data)
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  useEffect(() => { loadPlugins() }, [])

  const togglePlugin = async (filename: string, enabled: boolean) => {
    await api('POST', '/plugins', { filename, enabled })
    loadPlugins()
  }

  if (loading) return <p className="text-[12px] text-text-3/40">Loading plugins...</p>
  if (plugins.length === 0) return <p className="text-[12px] text-text-3/40">No plugins installed</p>

  return (
    <div className="space-y-2.5">
      {plugins.map((p) => (
        <div key={p.filename} className="flex items-center gap-3 py-3 px-4 rounded-[14px] bg-surface border border-white/[0.06]">
          <div className="flex-1 min-w-0">
            <div className="text-[14px] font-600 text-text truncate">{p.name}</div>
            <div className="text-[11px] font-mono text-text-3 truncate">{p.filename}</div>
            {p.description && <div className="text-[11px] text-text-3/60 mt-0.5">{p.description}</div>}
          </div>
          <div
            onClick={() => togglePlugin(p.filename, !p.enabled)}
            className={`w-11 h-6 rounded-full transition-all duration-200 relative cursor-pointer shrink-0
              ${p.enabled ? 'bg-[#6366F1]' : 'bg-white/[0.08]'}`}
          >
            <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200
              ${p.enabled ? 'left-[22px]' : 'left-0.5'}`} />
          </div>
        </div>
      ))}
    </div>
  )
}
