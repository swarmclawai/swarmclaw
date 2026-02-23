'use client'

import { useEffect, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { createSession, createCredential } from '@/lib/sessions'
import { TOOL_LABELS, TOOL_DESCRIPTIONS } from '@/components/chat/tool-call-bubble'
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select'
import type { ProviderType, SessionTool } from '@/types'

export function NewSessionView() {
    const setOpen = useAppStore((s) => s.setNewSessionOpen)

    const [name, setName] = useState('')
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
        loadProviders()
        loadCredentials()
        loadAgents()
        setName('')
        setProvider('claude-cli')
        setModel('')
        setCredentialId(null)
        setEndpoint('http://localhost:11434')
        setAddingKey(false)
        setNewKeyName('')
        setNewKeyValue('')
        setOllamaMode('local')
        const agentsList = Object.values(agents)
        const lastAgentId = typeof window !== 'undefined' ? localStorage.getItem('agent-ember-last-agent') : null
        const lastAgent = lastAgentId ? agentsList.find((a: any) => a.id === lastAgentId) : null
        const defaultAgent = lastAgent || agentsList.find((a: any) => a.id === 'default') || agentsList[0]
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
    }, [])

    useEffect(() => {
        if (currentProvider?.models.length) {
            setModel(currentProvider.models[0])
        }
        setCredentialId(null)
        if (provider !== 'ollama') setOllamaMode('local')
        if (currentProvider?.defaultEndpoint) setEndpoint(currentProvider.defaultEndpoint)
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
            if (providerCredentials.length > 0) setCredentialId(providerCredentials[0].id)
            else setCredentialId(null)
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
        const resolvedCredentialId = currentProvider?.requiresApiKey
            ? credentialId
            : (currentProvider?.optionalApiKey && ollamaMode === 'cloud') ? credentialId : null
        const agent = selectedAgentId ? agents[selectedAgentId] : null
        const agentTools = agent?.tools || (selectedTools.length ? selectedTools : undefined)
        const s = await createSession(
            sessionName, agent ? '~' : '', currentUser!,
            agent?.provider || provider,
            agent?.model || model || undefined,
            agent?.credentialId || resolvedCredentialId,
            selectedAgentId ? (agent?.apiEndpoint || null) : (currentProvider?.requiresEndpoint ? endpoint : null),
            selectedAgentId ? 'human' : undefined,
            selectedAgentId,
            agentTools || undefined,
            null,
        )
        if (selectedAgentId) {
            localStorage.setItem('agent-ember-last-agent', selectedAgentId)
        } else {
            localStorage.removeItem('agent-ember-last-agent')
        }
        updateSessionInStore(s)
        setCurrentSession(s.id)
        setMessages([])
        onClose()
    }

    const canCreate = () => {
        if (!selectedAgentId) {
            if (currentProvider?.requiresApiKey && !credentialId) return false
            if (provider === 'ollama' && ollamaMode === 'cloud' && !credentialId) return false
        }
        return true
    }

    const inputClass = 'w-full px-4 py-3.5 rounded-[14px] border border-border bg-muted/30 text-foreground text-[15px] outline-none transition-all duration-200 placeholder:text-muted-foreground/50 focus:ring-2 focus:ring-primary/30'

    return (
        <div className="flex-1 flex flex-col h-full min-h-0 overflow-y-auto bg-background">
            <div className="max-w-[560px] w-full mx-auto px-8 py-12">
                {/* Header */}
                <div className="mb-10 flex items-center gap-4">
                    <button
                        onClick={onClose}
                        className="w-9 h-9 rounded-[10px] border-none bg-transparent flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-all cursor-pointer shrink-0"
                    >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                            <polyline points="15 18 9 12 15 6" />
                        </svg>
                    </button>
                    <div>
                        <h1 className="font-display text-[28px] font-700 tracking-[-0.03em] leading-none mb-1">New Session</h1>
                        <p className="text-[14px] text-muted-foreground">Configure your AI session</p>
                    </div>
                </div>

                {/* Session Name */}
                <div className="mb-8">
                    <label className="block font-display text-[12px] font-600 text-muted-foreground uppercase tracking-[0.08em] mb-3">
                        Session Name <span className="normal-case tracking-normal font-normal text-muted-foreground/60">(optional — AI will name it)</span>
                    </label>
                    <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="e.g. Fix login bug"
                        className={inputClass}
                        style={{ fontFamily: 'inherit' }}
                        autoFocus
                    />
                </div>

                {/* Agent */}
                {Object.keys(agents).length > 0 && (
                    <div className="mb-8">
                        <label className="block font-display text-[12px] font-600 text-muted-foreground uppercase tracking-[0.08em] mb-3">
                            Agent <span className="normal-case tracking-normal font-normal text-muted-foreground/60">(optional)</span>
                        </label>
                        <Select
                            value={selectedAgentId || '__none__'}
                            onValueChange={(val) => handleSelectAgent(val === '__none__' ? null : val)}
                        >
                            <SelectTrigger className={inputClass}>
                                <SelectValue placeholder="None — manual configuration" />
                            </SelectTrigger>
                            <SelectContent className="bg-card border-border">
                                <SelectItem value="__none__">None — manual configuration</SelectItem>
                                {Object.values(agents).map((p) => (
                                    <SelectItem key={p.id} value={p.id}>
                                        {p.name}{p.isOrchestrator ? ' (Orchestrator)' : ''}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                )}

                {/* Provider/Model/Key/Endpoint */}
                {!selectedAgentId && (
                    <>
                        <div className="mb-8">
                            <label className="block font-display text-[12px] font-600 text-muted-foreground uppercase tracking-[0.08em] mb-3">
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
                                                ? 'bg-primary/10 border-primary/30 text-primary'
                                                : 'bg-muted/30 border-border text-muted-foreground hover:bg-muted hover:border-border/80'}`}
                                        style={{ fontFamily: 'inherit' }}
                                    >
                                        {p.name}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {provider === 'ollama' && (
                            <div className="mb-8">
                                <label className="block font-display text-[12px] font-600 text-muted-foreground uppercase tracking-[0.08em] mb-3">Mode</label>
                                <div className="flex p-1 rounded-[14px] bg-muted/30 border border-border">
                                    {(['local', 'cloud'] as const).map((mode) => (
                                        <button
                                            key={mode}
                                            onClick={() => setOllamaMode(mode)}
                                            className={`flex-1 py-3 rounded-[12px] text-center cursor-pointer transition-all duration-200
                        text-[14px] font-600 capitalize border-none
                        ${ollamaMode === mode ? 'bg-primary/10 text-primary' : 'bg-transparent text-muted-foreground hover:text-foreground'}`}
                                            style={{ fontFamily: 'inherit' }}
                                        >
                                            {mode}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}

                        {currentProvider && currentProvider.models.length > 0 && (
                            <div className="mb-8">
                                <label className="block font-display text-[12px] font-600 text-muted-foreground uppercase tracking-[0.08em] mb-3">Model</label>
                                <Select value={model} onValueChange={(val) => setModel(val)}>
                                    <SelectTrigger className={inputClass}>
                                        <SelectValue placeholder="Select model" />
                                    </SelectTrigger>
                                    <SelectContent className="bg-card border-border">
                                        {currentProvider.models.map((m) => (
                                            <SelectItem key={m} value={m}>{m}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                        )}

                        {(currentProvider?.requiresApiKey || (currentProvider?.optionalApiKey && ollamaMode === 'cloud')) && (
                            <div className="mb-8">
                                <label className="block font-display text-[12px] font-600 text-muted-foreground uppercase tracking-[0.08em] mb-3">API Key</label>
                                {providerCredentials.length > 0 && !addingKey ? (
                                    <Select
                                        value={credentialId || ''}
                                        onValueChange={(val) => {
                                            if (val === '__add__') setAddingKey(true)
                                            else setCredentialId(val)
                                        }}
                                    >
                                        <SelectTrigger className={inputClass}>
                                            <SelectValue placeholder="Select API key" />
                                        </SelectTrigger>
                                        <SelectContent className="bg-card border-border">
                                            {providerCredentials.map((c) => (
                                                <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                                            ))}
                                            <SelectItem value="__add__">+ Add new key...</SelectItem>
                                        </SelectContent>
                                    </Select>
                                ) : (
                                    <div className="space-y-3 p-5 rounded-[16px] bg-muted/30 border border-border">
                                        <input type="text" value={newKeyName} onChange={(e) => setNewKeyName(e.target.value)} placeholder="Key name (optional)" className={inputClass} style={{ fontFamily: 'inherit' }} />
                                        <input type="password" value={newKeyValue} onChange={(e) => setNewKeyValue(e.target.value)} placeholder="sk-..." className={inputClass} style={{ fontFamily: 'inherit' }} />
                                        <div className="flex gap-3 pt-2">
                                            {providerCredentials.length > 0 && (
                                                <button onClick={() => setAddingKey(false)} className="flex-1 py-3 rounded-[14px] border border-border bg-transparent text-foreground text-[14px] font-600 cursor-pointer hover:bg-muted transition-colors" style={{ fontFamily: 'inherit' }}>Cancel</button>
                                            )}
                                            <button onClick={handleAddKey} disabled={!newKeyValue.trim()} className="flex-1 py-3 rounded-[14px] border-none bg-primary text-primary-foreground text-[14px] font-600 cursor-pointer disabled:opacity-30 transition-all hover:brightness-110" style={{ fontFamily: 'inherit' }}>Save Key</button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}

                        {currentProvider?.requiresEndpoint && (provider === 'openclaw' || (provider === 'ollama' && ollamaMode === 'local')) && (
                            <div className="mb-8">
                                <label className="block font-display text-[12px] font-600 text-muted-foreground uppercase tracking-[0.08em] mb-3">
                                    {provider === 'openclaw' ? 'OpenClaw Endpoint' : 'Endpoint'}
                                </label>
                                <input type="text" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder={currentProvider.defaultEndpoint || 'http://localhost:11434'} className={`${inputClass} font-mono text-[14px]`} />
                            </div>
                        )}

                        {provider !== 'claude-cli' && (
                            <div className="mb-8">
                                <label className="block font-display text-[12px] font-600 text-muted-foreground uppercase tracking-[0.08em] mb-2">
                                    Tools <span className="normal-case tracking-normal font-normal text-muted-foreground/60">(optional)</span>
                                </label>
                                <p className="text-[12px] text-muted-foreground/60 mb-3">Allow this model to execute commands and access files in the session directory.</p>
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
                                                onClick={() => setSelectedTools((prev) => active ? prev.filter((t) => t !== id) : [...prev, id])}
                                                className={`px-4 py-2.5 rounded-[12px] text-[13px] font-600 border cursor-pointer transition-all duration-200 active:scale-[0.97]
                          ${active
                                                        ? 'bg-primary/10 border-primary/30 text-primary'
                                                        : 'bg-muted/30 border-border text-muted-foreground hover:bg-muted'}`}
                                                style={{ fontFamily: 'inherit' }}
                                                title={TOOL_DESCRIPTIONS[id] || id}
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

                {/* Agent summary */}
                {selectedAgentId && agents[selectedAgentId] && (
                    <div className="mb-8 px-4 py-3 rounded-[14px] bg-muted/30 border border-border">
                        <span className="text-[13px] text-muted-foreground">
                            Using <span className="text-foreground font-600">{agents[selectedAgentId].provider}</span>
                            {' / '}
                            <span className="text-foreground font-600">{agents[selectedAgentId].model}</span>
                            {agents[selectedAgentId].tools?.length ? (
                                <> + {agents[selectedAgentId].tools!.map((tool, i) => (
                                    <span key={tool}>
                                        {i > 0 && ', '}
                                        <span className="text-primary/70 font-600 cursor-help" title={TOOL_DESCRIPTIONS[tool] || tool}>
                                            {TOOL_LABELS[tool] || tool.replace(/_/g, ' ')}
                                        </span>
                                    </span>
                                ))}</>
                            ) : null}
                        </span>
                    </div>
                )}

                {/* Actions */}
                <div className="flex gap-3 pt-6 border-t border-border">
                    <button
                        onClick={onClose}
                        className="flex-1 py-3.5 rounded-[14px] border border-border bg-transparent text-foreground text-[15px] font-600 cursor-pointer hover:bg-muted transition-all duration-200"
                        style={{ fontFamily: 'inherit' }}
                    >
                        Cancel
                    </button>
                    <button
                        onClick={() => { /* TODO: load session from file */ }}
                        className="flex-1 py-3.5 rounded-[14px] border border-border bg-transparent text-muted-foreground text-[15px] font-600 cursor-pointer hover:bg-muted hover:text-foreground transition-all duration-200"
                        style={{ fontFamily: 'inherit' }}
                    >
                        Load from file
                    </button>
                    <button
                        onClick={handleCreate}
                        disabled={!canCreate()}
                        className="flex-1 py-3.5 rounded-[14px] border-none bg-primary text-primary-foreground text-[15px] font-600 cursor-pointer
              active:scale-[0.97] disabled:opacity-30 transition-all duration-200
              shadow-[0_4px_20px_rgba(var(--primary-rgb),0.25)] hover:brightness-110"
                        style={{ fontFamily: 'inherit' }}
                    >
                        Create Session
                    </button>
                </div>
            </div>
        </div>
    )
}
