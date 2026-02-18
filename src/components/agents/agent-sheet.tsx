'use client'

import { useEffect, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { createAgent, updateAgent, deleteAgent } from '@/lib/agents'
import { api } from '@/lib/api-client'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import type { ProviderType, Skill, ClaudeSkill } from '@/types'

const AVAILABLE_TOOLS: { id: string; label: string; description: string }[] = [
  { id: 'shell', label: 'Shell', description: 'Execute commands in the working directory' },
  { id: 'files', label: 'Files', description: 'Read, write, and list files' },
  { id: 'claude_code', label: 'Claude Code', description: 'Delegate complex tasks to Claude Code CLI' },
  { id: 'browser', label: 'Browser', description: 'Playwright — browse, scrape, interact with web pages' },
]

export function AgentSheet() {
  const open = useAppStore((s) => s.agentSheetOpen)
  const setOpen = useAppStore((s) => s.setAgentSheetOpen)
  const editingId = useAppStore((s) => s.editingAgentId)
  const setEditingId = useAppStore((s) => s.setEditingAgentId)
  const agents = useAppStore((s) => s.agents)
  const loadAgents = useAppStore((s) => s.loadAgents)
  const providers = useAppStore((s) => s.providers)
  const loadProviders = useAppStore((s) => s.loadProviders)
  const credentials = useAppStore((s) => s.credentials)
  const loadCredentials = useAppStore((s) => s.loadCredentials)
  const dynamicSkills = useAppStore((s) => s.skills)
  const loadSkills = useAppStore((s) => s.loadSkills)

  const [claudeSkills, setClaudeSkills] = useState<ClaudeSkill[]>([])
  const [claudeSkillsLoading, setClaudeSkillsLoading] = useState(false)
  const loadClaudeSkills = async () => {
    setClaudeSkillsLoading(true)
    try {
      const skills = await api<ClaudeSkill[]>('GET', '/claude-skills')
      setClaudeSkills(skills)
    } catch { /* ignore */ }
    finally { setClaudeSkillsLoading(false) }
  }

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [soul, setSoul] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [provider, setProvider] = useState<ProviderType>('claude-cli')
  const [model, setModel] = useState('')
  const [credentialId, setCredentialId] = useState<string | null>(null)
  const [apiEndpoint, setApiEndpoint] = useState<string | null>(null)
  const [isOrchestrator, setIsOrchestrator] = useState(false)
  const [subAgentIds, setAgentAgentIds] = useState<string[]>([])
  const [tools, setTools] = useState<string[]>([])
  const [skills, setSkills] = useState<string[]>([])
  const [skillIds, setSkillIds] = useState<string[]>([])
  const [ollamaMode, setOllamaMode] = useState<'local' | 'cloud'>('local')

  // AI generation state
  const [aiPrompt, setAiPrompt] = useState('')
  const [generating, setGenerating] = useState(false)
  const [generated, setGenerated] = useState(false)
  const [genError, setGenError] = useState('')

  const currentProvider = providers.find((p) => p.id === provider)
  const providerCredentials = Object.values(credentials).filter((c) => c.provider === provider)
  const editing = editingId ? agents[editingId] : null

  useEffect(() => {
    if (open) {
      loadProviders()
      loadCredentials()
      loadSkills()
      loadClaudeSkills()
      setAiPrompt('')
      setGenerating(false)
      setGenerated(false)
      setGenError('')
      if (editing) {
        setName(editing.name)
        setDescription(editing.description)
        setSoul(editing.soul || '')
        setSystemPrompt(editing.systemPrompt)
        setProvider(editing.provider)
        setModel(editing.model)
        setCredentialId(editing.credentialId || null)
        setApiEndpoint(editing.apiEndpoint || null)
        setIsOrchestrator(editing.isOrchestrator || false)
        setAgentAgentIds(editing.subAgentIds || [])
        setTools(editing.tools || [])
        setSkills(editing.skills || [])
        setSkillIds(editing.skillIds || [])
        setOllamaMode(editing.credentialId && editing.provider === 'ollama' ? 'cloud' : 'local')
      } else {
        setName('')
        setDescription('')
        setSoul('')
        setSystemPrompt('')
        setProvider('claude-cli')
        setModel('')
        setCredentialId(null)
        setApiEndpoint(null)
        setIsOrchestrator(false)
        setAgentAgentIds([])
        setTools([])
        setSkills([])
        setSkillIds([])
        setOllamaMode('local')
      }
    }
  }, [open, editingId])

  useEffect(() => {
    if (currentProvider?.models.length && !editing) {
      setModel(currentProvider.models[0])
    }
  }, [provider, providers])

  const handleGenerate = async () => {
    if (!aiPrompt.trim()) return
    setGenerating(true)
    setGenError('')
    try {
      const result = await api<{ name?: string; description?: string; systemPrompt?: string; isOrchestrator?: boolean; error?: string }>('POST', '/agents/generate', { prompt: aiPrompt })
      if (result.error) {
        setGenError(result.error)
      } else if (result.name || result.systemPrompt) {
        if (result.name) setName(result.name)
        if (result.description) setDescription(result.description)
        if (result.systemPrompt) setSystemPrompt(result.systemPrompt)
        if (result.isOrchestrator !== undefined) setIsOrchestrator(result.isOrchestrator)
        setGenerated(true)
      } else {
        setGenError('AI returned empty response — try again')
      }
    } catch (err: any) {
      setGenError(err.message || 'Generation failed')
    }
    setGenerating(false)
  }

  const onClose = () => {
    setOpen(false)
    setEditingId(null)
  }

  const handleSave = async () => {
    const data = {
      name: name.trim() || 'Unnamed Agent',
      description,
      soul,
      systemPrompt,
      provider,
      model,
      credentialId,
      apiEndpoint,
      isOrchestrator,
      subAgentIds: isOrchestrator ? subAgentIds : [],
      tools,
      skills,
      skillIds,
    }
    if (editing) {
      await updateAgent(editing.id, data)
    } else {
      await createAgent(data)
    }
    await loadAgents()
    onClose()
  }

  const handleDelete = async () => {
    if (editing) {
      await deleteAgent(editing.id)
      await loadAgents()
      onClose()
    }
  }

  const agentOptions = Object.values(agents).filter((p) => !p.isOrchestrator && p.id !== editingId)

  const toggleAgent = (id: string) => {
    setAgentAgentIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    )
  }

  const inputClass = "w-full px-4 py-3.5 rounded-[14px] border border-white/[0.08] bg-surface text-text text-[15px] outline-none transition-all duration-200 placeholder:text-text-3/50 focus-glow"

  return (
    <BottomSheet open={open} onClose={onClose} wide>
      <div className="mb-10">
        <h2 className="font-display text-[28px] font-700 tracking-[-0.03em] mb-2">
          {editing ? 'Edit Agent' : 'New Agent'}
        </h2>
        <p className="text-[14px] text-text-3">Define an AI agent or orchestrator</p>
      </div>

      {/* AI Generation */}
      {!editing && (
        <div className="mb-10 p-5 rounded-[18px] border border-[#6366F1]/15 bg-[#6366F1]/[0.03]">
          <div className="flex items-center gap-2.5 mb-4">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-accent-bright shrink-0">
              <path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z" fill="currentColor" />
            </svg>
            <span className="font-display text-[13px] font-600 text-accent-bright">Generate with AI</span>
          </div>
          <textarea
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
            placeholder="Describe the agent you want, e.g. &quot;An SEO keyword researcher that finds low-competition long-tail keywords in the health niche and outputs them as structured data&quot;"
            rows={3}
            className="w-full px-4 py-3 rounded-[12px] border border-[#6366F1]/10 bg-[#6366F1]/[0.02] text-text text-[14px] outline-none transition-all duration-200 placeholder:text-text-3/40 focus:border-[#6366F1]/30 resize-none"
            style={{ fontFamily: 'inherit' }}
          />
          <button
            onClick={handleGenerate}
            disabled={generating || !aiPrompt.trim()}
            className="mt-3 px-5 py-2.5 rounded-[12px] border-none bg-[#6366F1] text-white text-[13px] font-600 cursor-pointer
              disabled:opacity-30 transition-all hover:brightness-110 active:scale-[0.97]
              shadow-[0_2px_12px_rgba(99,102,241,0.2)]"
            style={{ fontFamily: 'inherit' }}
          >
            {generating ? 'Generating...' : generated ? 'Regenerate' : 'Generate'}
          </button>
          {generated && (
            <span className="ml-3 text-[12px] text-emerald-400/70">Fields populated — edit as needed below</span>
          )}
          {genError && (
            <p className="mt-2 text-[12px] text-red-400/80">{genError}</p>
          )}
        </div>
      )}

      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Name</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. SEO Researcher" className={inputClass} style={{ fontFamily: 'inherit' }} />
      </div>

      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Description</label>
        <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What does this agent do?" className={inputClass} style={{ fontFamily: 'inherit' }} />
      </div>

      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
          Soul / Personality <span className="normal-case tracking-normal font-normal text-text-3">(optional)</span>
        </label>
        <p className="text-[12px] text-text-3/60 mb-3">Define the agent&apos;s voice, tone, and personality. Injected before the system prompt.</p>
        <textarea
          value={soul}
          onChange={(e) => setSoul(e.target.value)}
          placeholder="e.g. You speak concisely and directly. You have a dry sense of humor. You always back claims with data."
          rows={3}
          className={`${inputClass} resize-y min-h-[80px]`}
          style={{ fontFamily: 'inherit' }}
        />
      </div>

      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">System Prompt</label>
        <textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder="You are an expert..."
          rows={5}
          className={`${inputClass} resize-y min-h-[120px]`}
          style={{ fontFamily: 'inherit' }}
        />
      </div>

      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Provider</label>
        <div className="grid grid-cols-3 gap-3">
          {providers.filter((p) => !isOrchestrator || p.id !== 'claude-cli').map((p) => (
            <button
              key={p.id}
              onClick={() => setProvider(p.id)}
              className={`py-3.5 px-4 rounded-[14px] text-center cursor-pointer transition-all duration-200
                active:scale-[0.97] text-[14px] font-600 border
                ${provider === p.id
                  ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
                  : 'bg-surface border-white/[0.06] text-text-2 hover:bg-surface-2'}`}
              style={{ fontFamily: 'inherit' }}
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>

      {currentProvider && currentProvider.models.length > 0 && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Model</label>
          <select value={model} onChange={(e) => setModel(e.target.value)} className={`${inputClass} appearance-none cursor-pointer`} style={{ fontFamily: 'inherit' }}>
            {currentProvider.models.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
      )}

      {/* Ollama Mode Toggle */}
      {provider === 'ollama' && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Mode</label>
          <div className="flex p-1 rounded-[14px] bg-surface border border-white/[0.06]">
            {(['local', 'cloud'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => {
                  setOllamaMode(mode)
                  if (mode === 'local') {
                    setApiEndpoint('http://localhost:11434')
                    setCredentialId(null)
                  } else {
                    setApiEndpoint(null)
                    if (providerCredentials.length > 0) setCredentialId(providerCredentials[0].id)
                  }
                }}
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

      {(currentProvider?.requiresApiKey || (provider === 'ollama' && ollamaMode === 'cloud')) && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">API Key</label>
          <select value={credentialId || ''} onChange={(e) => setCredentialId(e.target.value || null)} className={`${inputClass} appearance-none cursor-pointer`} style={{ fontFamily: 'inherit' }}>
            <option value="">Select a key...</option>
            {providerCredentials.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
      )}

      {currentProvider?.requiresEndpoint && provider === 'ollama' && ollamaMode === 'local' && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Endpoint</label>
          <input type="text" value={apiEndpoint || ''} onChange={(e) => setApiEndpoint(e.target.value || null)} placeholder="http://localhost:11434" className={`${inputClass} font-mono text-[14px]`} />
        </div>
      )}

      {/* Tools */}
      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">Tools</label>
        <p className="text-[12px] text-text-3/60 mb-3">
          {provider === 'claude-cli' ? 'Claude Code has built-in tools. Toggle browser for web browsing.' : 'Enable tools for LangGraph agent sessions.'}
        </p>
        <div className="space-y-3">
          {AVAILABLE_TOOLS.filter((t) => provider === 'claude-cli' ? t.id === 'browser' : true).map((t) => (
            <label key={t.id} className="flex items-center gap-3 cursor-pointer">
              <div
                onClick={() => setTools((prev) => prev.includes(t.id) ? prev.filter((x) => x !== t.id) : [...prev, t.id])}
                className={`w-11 h-6 rounded-full transition-all duration-200 relative cursor-pointer shrink-0
                  ${tools.includes(t.id) ? 'bg-[#6366F1]' : 'bg-white/[0.08]'}`}
              >
                <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200
                  ${tools.includes(t.id) ? 'left-[22px]' : 'left-0.5'}`} />
              </div>
              <span className="font-display text-[14px] font-600 text-text-2">{t.label}</span>
              <span className="text-[12px] text-text-3">{t.description}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Skills — discovered from ~/.claude/skills/ */}
      {provider === 'claude-cli' && (
        <div className="mb-8">
          <div className="flex items-center justify-between mb-2">
            <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em]">
              Skills <span className="normal-case tracking-normal font-normal text-text-3">(from ~/.claude/skills/)</span>
            </label>
            <button
              onClick={loadClaudeSkills}
              disabled={claudeSkillsLoading}
              className="text-[11px] text-text-3 hover:text-accent-bright transition-colors cursor-pointer bg-transparent border-none flex items-center gap-1"
              style={{ fontFamily: 'inherit' }}
              title="Refresh skills from ~/.claude/skills/"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                className={claudeSkillsLoading ? 'animate-spin' : ''}>
                <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
              </svg>
              Refresh
            </button>
          </div>
          <p className="text-[12px] text-text-3/60 mb-3">When delegated to, this agent will be instructed to use these skills.</p>
          {claudeSkills.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {claudeSkills.map((s) => {
                const active = skills.includes(s.id)
                return (
                  <button
                    key={s.id}
                    onClick={() => setSkills((prev) => active ? prev.filter((x) => x !== s.id) : [...prev, s.id])}
                    className={`px-3 py-2 rounded-[10px] text-[13px] font-600 cursor-pointer transition-all border
                      ${active
                        ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
                        : 'bg-surface border-white/[0.06] text-text-3 hover:text-text-2'}`}
                    style={{ fontFamily: 'inherit' }}
                    title={s.description}
                  >
                    {s.name}
                  </button>
                )
              })}
            </div>
          ) : (
            <p className="text-[12px] text-text-3/40">No skills found in ~/.claude/skills/</p>
          )}
        </div>
      )}

      {/* Dynamic Skills from Skills Manager */}
      {Object.keys(dynamicSkills).length > 0 && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
            Custom Skills <span className="normal-case tracking-normal font-normal text-text-3">(from Skills manager)</span>
          </label>
          <p className="text-[12px] text-text-3/60 mb-3">Skill content is injected into the system prompt when this agent runs.</p>
          <div className="flex flex-wrap gap-2">
            {Object.values(dynamicSkills).map((s) => {
              const active = skillIds.includes(s.id)
              return (
                <button
                  key={s.id}
                  onClick={() => setSkillIds((prev) => active ? prev.filter((x) => x !== s.id) : [...prev, s.id])}
                  className={`px-3 py-2 rounded-[10px] text-[13px] font-600 cursor-pointer transition-all border
                    ${active
                      ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
                      : 'bg-surface border-white/[0.06] text-text-3 hover:text-text-2'}`}
                  style={{ fontFamily: 'inherit' }}
                  title={s.description || s.filename}
                >
                  {s.name}
                </button>
              )
            })}
          </div>
        </div>
      )}

      <div className="mb-8">
        <label className="flex items-center gap-3 cursor-pointer">
          <div
            onClick={() => {
              const next = !isOrchestrator
              setIsOrchestrator(next)
              if (next && provider === 'claude-cli') setProvider('anthropic')
            }}
            className={`w-11 h-6 rounded-full transition-all duration-200 relative cursor-pointer
              ${isOrchestrator ? 'bg-[#6366F1]' : 'bg-white/[0.08]'}`}
          >
            <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200
              ${isOrchestrator ? 'left-[22px]' : 'left-0.5'}`} />
          </div>
          <span className="font-display text-[14px] font-600 text-text-2">Orchestrator</span>
          <span className="text-[12px] text-text-3">Can delegate tasks to other agents</span>
        </label>
      </div>

      {isOrchestrator && agentOptions.length > 0 && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Available Agents</label>
          <div className="flex flex-wrap gap-2">
            {agentOptions.map((a) => (
              <button
                key={a.id}
                onClick={() => toggleAgent(a.id)}
                className={`px-3 py-2 rounded-[10px] text-[13px] font-600 cursor-pointer transition-all border
                  ${subAgentIds.includes(a.id)
                    ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
                    : 'bg-surface border-white/[0.06] text-text-3 hover:text-text-2'}`}
                style={{ fontFamily: 'inherit' }}
              >
                {a.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex gap-3 pt-2 border-t border-white/[0.04]">
        {editing && (
          <button onClick={handleDelete} className="py-3.5 px-6 rounded-[14px] border border-red-500/20 bg-transparent text-red-400 text-[15px] font-600 cursor-pointer hover:bg-red-500/10 transition-all" style={{ fontFamily: 'inherit' }}>
            Delete
          </button>
        )}
        <button onClick={onClose} className="flex-1 py-3.5 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[15px] font-600 cursor-pointer hover:bg-surface-2 transition-all" style={{ fontFamily: 'inherit' }}>
          Cancel
        </button>
        <button onClick={handleSave} disabled={!name.trim()} className="flex-1 py-3.5 rounded-[14px] border-none bg-[#6366F1] text-white text-[15px] font-600 cursor-pointer active:scale-[0.97] disabled:opacity-30 transition-all shadow-[0_4px_20px_rgba(99,102,241,0.25)] hover:brightness-110" style={{ fontFamily: 'inherit' }}>
          {editing ? 'Save' : 'Create'}
        </button>
      </div>
    </BottomSheet>
  )
}
