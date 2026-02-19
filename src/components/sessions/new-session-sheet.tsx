'use client'

import { useEffect, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { createSession, createCredential } from '@/lib/sessions'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import { DirBrowser } from '@/components/shared/dir-browser'
import type { ProviderType, SessionTool } from '@/types'

export function NewSessionSheet() {
  const open = useAppStore((s) => s.newSessionOpen)
  const setOpen = useAppStore((s) => s.setNewSessionOpen)

  const [name, setName] = useState('')
  const [selectedDir, setSelectedDir] = useState<string | null>(null)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [provider, setProvider] = useState<ProviderType>('claude-cli')
  const [model, setModel] = useState('')
  const [credentialId, setCredentialId] = useState<string | null>(null)
  const [endpoint, setEndpoint] = useState('http://localhost:11434')
  const [addingKey, setAddingKey] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [newKeyValue, setNewKeyValue] = useState('')
  const [ollamaMode, setOllamaMode] = useState<'local' | 'cloud'>('local')
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [selectedTools, setSelectedTools] = useState<SessionTool[]>([])

  const providers = useAppStore((s) => s.providers)
  const loadProviders = useAppStore((s) => s.loadProviders)
  const credentials = useAppStore((s) => s.credentials)
  const loadCredentials = useAppStore((s) => s.loadCredentials)
  const agents = useAppStore((s) => s.agents)
  const loadAgents = useAppStore((s) => s.loadAgents)
  const currentUser = useAppStore((s) => s.currentUser)
  const updateSessionInStore = useAppStore((s) => s.updateSessionInStore)
  const setCurrentSession = useAppStore((s) => s.setCurrentSession)
  const setMessages = useChatStore((s) => s.setMessages)

  const currentProvider = providers.find((p) => p.id === provider)
  const providerCredentials = Object.values(credentials).filter((c) => c.provider === provider)

  useEffect(() => {
    if (open) {
      loadProviders()
      loadCredentials()
      loadAgents()
      setName('')
      setSelectedDir(null)
      setSelectedFile(null)
      setProvider('claude-cli')
      setModel('')
      setCredentialId(null)
      setEndpoint('http://localhost:11434')
      setAddingKey(false)
      setNewKeyName('')
      setNewKeyValue('')
      setOllamaMode('local')
      // Auto-select default agent if available
      const agentsList = Object.values(agents)
      const defaultAgent = agentsList.find((a: any) => a.id === 'default') || agentsList[0]
      if (defaultAgent) {
        setSelectedAgentId((defaultAgent as any).id)
        setProvider((defaultAgent as any).provider || 'claude-cli')
        setModel((defaultAgent as any).model || '')
        setCredentialId((defaultAgent as any).credentialId || null)
        if ((defaultAgent as any).apiEndpoint) setEndpoint((defaultAgent as any).apiEndpoint)
      } else {
        setSelectedAgentId(null)
      }
      setSelectedTools([])
    }
  }, [open])

  useEffect(() => {
    if (currentProvider?.models.length) {
      setModel(currentProvider.models[0])
    }
    setCredentialId(null)
    if (provider !== 'ollama') {
      setOllamaMode('local')
    }
    if (currentProvider?.defaultEndpoint) {
      setEndpoint(currentProvider.defaultEndpoint)
    }
  }, [provider, providers])

  useEffect(() => {
    const needsKey = currentProvider?.requiresApiKey || (provider === 'ollama' && ollamaMode === 'cloud')
    if (needsKey && providerCredentials.length > 0 && !credentialId) {
      setCredentialId(providerCredentials[0].id)
    }
  }, [providerCredentials.length, provider, ollamaMode])

  useEffect(() => {
    if (ollamaMode === 'local') {
      setEndpoint('http://localhost:11434')
      setCredentialId(null)
    } else {
      setEndpoint('')
      // Auto-select first credential for cloud
      if (providerCredentials.length > 0) {
        setCredentialId(providerCredentials[0].id)
      } else {
        setCredentialId(null)
      }
    }
  }, [ollamaMode])

  const handleAddKey = async () => {
    if (!newKeyValue.trim()) return
    const cred = await createCredential(provider, newKeyName || `${provider} key`, newKeyValue)
    await loadCredentials()
    setCredentialId(cred.id)
    setAddingKey(false)
    setNewKeyName('')
    setNewKeyValue('')
  }

  const onClose = () => setOpen(false)

  const handleSelectAgent = (agentId: string | null) => {
    setSelectedAgentId(agentId)
    if (agentId && agents[agentId]) {
      const p = agents[agentId]
      setProvider(p.provider)
      setModel(p.model)
      setCredentialId(p.credentialId || null)
      if (p.apiEndpoint) setEndpoint(p.apiEndpoint)
      if (!name) setName(p.name)
    }
  }

  const handleCreate = async () => {
    const sessionName = name.trim() || 'New Session'
    const cwd = selectedDir || ''
    const resolvedCredentialId = currentProvider?.requiresApiKey
      ? credentialId
      : (currentProvider?.optionalApiKey && ollamaMode === 'cloud') ? credentialId : null
    const agent = selectedAgentId ? agents[selectedAgentId] : null
    const agentTools = agent?.tools || (selectedTools.length ? selectedTools : undefined)
    const s = await createSession(
      sessionName, cwd || (agent ? '~' : ''), currentUser!,
      agent?.provider || provider,
      agent?.model || model || undefined,
      agent?.credentialId || resolvedCredentialId,
      selectedAgentId ? (agent?.apiEndpoint || null) : (currentProvider?.requiresEndpoint ? endpoint : null),
      selectedAgentId ? 'human' : undefined,
      selectedAgentId,
      agentTools || undefined,
      selectedFile,
    )
    updateSessionInStore(s)
    setCurrentSession(s.id)
    setMessages([])
    onClose()
  }

  const canCreate = () => {
    if (!selectedAgentId) {
      if (currentProvider?.requiresApiKey && !credentialId) return false
      if (provider === 'ollama' && ollamaMode === 'cloud' && !credentialId) return false
      if (provider === 'claude-cli' && !selectedDir) return false
    }
    return true
  }

  const inputClass = "w-full px-4 py-3.5 rounded-[14px] border border-white/[0.08] bg-surface text-text text-[15px] outline-none transition-all duration-200 placeholder:text-text-3/50 focus-glow"

  return (
    <BottomSheet open={open} onClose={onClose} wide>
      {/* Header */}
      <div className="mb-10">
        <h2 className="font-display text-[28px] font-700 tracking-[-0.03em] mb-2">New Session</h2>
        <p className="text-[14px] text-text-3">Configure your AI session</p>
      </div>

      {/* Name */}
      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">
          Session Name
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Fix login bug"
          className={inputClass}
          style={{ fontFamily: 'inherit' }}
        />
      </div>

      {/* Agent (optional) */}
      {Object.keys(agents).length > 0 && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">
            Agent <span className="normal-case tracking-normal font-normal text-text-3">(optional)</span>
          </label>
          <select
            value={selectedAgentId || ''}
            onChange={(e) => handleSelectAgent(e.target.value || null)}
            className={`${inputClass} appearance-none cursor-pointer`}
            style={{ fontFamily: 'inherit' }}
          >
            <option value="">None — manual configuration</option>
            {Object.values(agents).map((p) => (
              <option key={p.id} value={p.id}>{p.name}{p.isOrchestrator ? ' (Orchestrator)' : ''}</option>
            ))}
          </select>
        </div>
      )}

      {/* Provider/Model/Key/Endpoint — only show when no agent selected */}
      {!selectedAgentId && (
        <>
          {/* Provider */}
          <div className="mb-8">
            <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">
              Provider
            </label>
            <div className="grid grid-cols-3 gap-3">
              {providers.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setProvider(p.id)}
                  className={`py-3.5 px-4 rounded-[14px] text-center cursor-pointer transition-all duration-200
                    active:scale-[0.97] text-[14px] font-600 border
                    ${provider === p.id
                      ? 'bg-accent-soft border-accent-bright/25 text-accent-bright shadow-[0_0_20px_rgba(99,102,241,0.1)]'
                      : 'bg-surface border-white/[0.06] text-text-2 hover:bg-surface-2 hover:border-white/[0.08]'}`}
                  style={{ fontFamily: 'inherit' }}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>

          {/* Ollama Mode Toggle */}
          {provider === 'ollama' && (
            <div className="mb-8">
              <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">
                Mode
              </label>
              <div className="flex p-1 rounded-[14px] bg-surface border border-white/[0.06]">
                {(['local', 'cloud'] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setOllamaMode(mode)}
                    className={`flex-1 py-3 rounded-[12px] text-center cursor-pointer transition-all duration-200
                      text-[14px] font-600 capitalize
                      ${ollamaMode === mode
                        ? 'bg-accent-soft text-accent-bright shadow-[0_0_20px_rgba(99,102,241,0.1)]'
                        : 'bg-transparent text-text-3 hover:text-text-2'}`}
                    style={{ fontFamily: 'inherit' }}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Model */}
          {currentProvider && currentProvider.models.length > 0 && (
            <div className="mb-8">
              <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">
                Model
              </label>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className={`${inputClass} appearance-none cursor-pointer`}
                style={{ fontFamily: 'inherit' }}
              >
                {currentProvider.models.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
          )}

          {/* API Key */}
          {(currentProvider?.requiresApiKey || (currentProvider?.optionalApiKey && ollamaMode === 'cloud')) && (
            <div className="mb-8">
              <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">
                API Key
              </label>
              {providerCredentials.length > 0 && !addingKey ? (
                <select
                  value={credentialId || ''}
                  onChange={(e) => {
                    if (e.target.value === '__add__') {
                      setAddingKey(true)
                    } else {
                      setCredentialId(e.target.value)
                    }
                  }}
                  className={`${inputClass} appearance-none cursor-pointer`}
                  style={{ fontFamily: 'inherit' }}
                >
                  {providerCredentials.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                  <option value="__add__">+ Add new key...</option>
                </select>
              ) : (
                <div className="space-y-3 p-5 rounded-[16px] bg-surface-2 border border-white/[0.06]">
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
                    placeholder="sk-..."
                    className={inputClass}
                    style={{ fontFamily: 'inherit' }}
                  />
                  <div className="flex gap-3 pt-2">
                    {providerCredentials.length > 0 && (
                      <button
                        onClick={() => setAddingKey(false)}
                        className="flex-1 py-3 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[14px] font-600 cursor-pointer hover:bg-surface-2 transition-colors"
                        style={{ fontFamily: 'inherit' }}
                      >
                        Cancel
                      </button>
                    )}
                    <button
                      onClick={handleAddKey}
                      disabled={!newKeyValue.trim()}
                      className="flex-1 py-3 rounded-[14px] border-none bg-[#6366F1] text-white text-[14px] font-600 cursor-pointer disabled:opacity-30 transition-all hover:brightness-110"
                      style={{ fontFamily: 'inherit' }}
                    >
                      Save Key
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Endpoint — show for providers that require it (Ollama local, OpenClaw) */}
          {currentProvider?.requiresEndpoint && (provider === 'openclaw' || (provider === 'ollama' && ollamaMode === 'local')) && (
            <div className="mb-8">
              <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">
                {provider === 'openclaw' ? 'OpenClaw Endpoint' : 'Endpoint'}
              </label>
              <input
                type="text"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                placeholder={currentProvider.defaultEndpoint || 'http://localhost:11434'}
                className={`${inputClass} font-mono text-[14px]`}
              />
              {provider === 'openclaw' && (
                <p className="text-[11px] text-text-3/60 mt-2">
                  The /v1 endpoint of your remote OpenClaw instance
                </p>
              )}
            </div>
          )}
          {/* Tools */}
          {provider !== 'claude-cli' && (
            <div className="mb-8">
              <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
                Tools <span className="normal-case tracking-normal font-normal text-text-3">(optional)</span>
              </label>
              <p className="text-[12px] text-text-3/60 mb-3">Allow this model to execute commands and access files in the session directory.</p>
              <div className="flex flex-wrap gap-2.5">
                {([
                  { id: 'shell' as SessionTool, label: 'Shell' },
                  { id: 'files' as SessionTool, label: 'Files' },
                  { id: 'edit_file' as SessionTool, label: 'Edit File' },
                  { id: 'web_search' as SessionTool, label: 'Web Search' },
                  { id: 'web_fetch' as SessionTool, label: 'Web Fetch' },
                  { id: 'claude_code' as SessionTool, label: 'Claude Code' },
                ]).map(({ id, label }) => {
                  const active = selectedTools.includes(id)
                  return (
                    <button
                      key={id}
                      onClick={() => {
                        setSelectedTools((prev) =>
                          active ? prev.filter((t) => t !== id) : [...prev, id],
                        )
                      }}
                      className={`px-4 py-2.5 rounded-[12px] text-[13px] font-600 border cursor-pointer transition-all duration-200 active:scale-[0.97]
                        ${active
                          ? 'bg-accent-soft border-accent-bright/25 text-accent-bright shadow-[0_0_20px_rgba(99,102,241,0.1)]'
                          : 'bg-surface border-white/[0.06] text-text-3 hover:bg-surface-2 hover:border-white/[0.08]'}`}
                      style={{ fontFamily: 'inherit' }}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </>
      )}

      {/* Summary when agent selected */}
      {selectedAgentId && agents[selectedAgentId] && (
        <div className="mb-8 px-4 py-3 rounded-[14px] bg-surface border border-white/[0.06]">
          <span className="text-[13px] text-text-3">
            Using <span className="text-text-2 font-600">{agents[selectedAgentId].provider}</span>
            {' / '}
            <span className="text-text-2 font-600">{agents[selectedAgentId].model}</span>
            {agents[selectedAgentId].tools?.length ? (
              <> + <span className="text-sky-400/70 font-600">{agents[selectedAgentId].tools!.join(', ')}</span></>
            ) : null}
          </span>
        </div>
      )}

      {/* Project */}
      <div className="mb-10">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">
          Directory {provider !== 'claude-cli' && <span className="normal-case tracking-normal font-normal text-text-3">(optional)</span>}
        </label>
        <DirBrowser
          value={selectedDir}
          file={selectedFile}
          onChange={(dir, file) => {
            setSelectedDir(dir)
            setSelectedFile(file ?? null)
            if (!name) {
              const dirName = dir.split('/').pop() || ''
              setName(dirName)
            }
          }}
          onClear={() => { setSelectedDir(null); setSelectedFile(null) }}
        />
      </div>

      {/* Actions */}
      <div className="flex gap-3 pt-2 border-t border-white/[0.04]">
        <button
          onClick={onClose}
          className="flex-1 py-3.5 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[15px] font-600 cursor-pointer
            hover:bg-surface-2 transition-all duration-200"
          style={{ fontFamily: 'inherit' }}
        >
          Cancel
        </button>
        <button
          onClick={handleCreate}
          disabled={!canCreate()}
          className="flex-1 py-3.5 rounded-[14px] border-none bg-[#6366F1] text-white text-[15px] font-600 cursor-pointer
            active:scale-[0.97] disabled:opacity-30 transition-all duration-200
            shadow-[0_4px_20px_rgba(99,102,241,0.25)] hover:brightness-110"
          style={{ fontFamily: 'inherit' }}
        >
          Create Session
        </button>
      </div>
    </BottomSheet>
  )
}
