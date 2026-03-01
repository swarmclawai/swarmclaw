'use client'

import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { createAgent, updateAgent, deleteAgent } from '@/lib/agents'
import { api } from '@/lib/api-client'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import { toast } from 'sonner'
import { ModelCombobox } from '@/components/shared/model-combobox'
import type { ProviderType, ClaudeSkill } from '@/types'
import { AVAILABLE_TOOLS, PLATFORM_TOOLS } from '@/lib/tool-definitions'
import { NATIVE_CAPABILITY_PROVIDER_IDS, NON_LANGGRAPH_PROVIDER_IDS } from '@/lib/provider-sets'
import { AgentAvatar } from './agent-avatar'

const HB_PRESETS = [30, 60, 120, 300, 600, 1800, 3600] as const

function formatHbDuration(sec: number): string {
  if (sec >= 3600) {
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    return m > 0 ? `${h}h${m}m` : `${h}h`
  }
  if (sec >= 60) return `${Math.floor(sec / 60)}m`
  return `${sec}s`
}

/** Parse a stored heartbeatInterval string or heartbeatIntervalSec number to a select-friendly string of seconds */
function parseDurationToSec(interval: string | number | null | undefined, intervalSec: number | null | undefined): string {
  if (intervalSec != null && Number.isFinite(intervalSec) && intervalSec > 0) {
    // Snap to nearest preset if close, otherwise use raw value
    const closest = HB_PRESETS.find((p) => p === Math.round(intervalSec))
    if (closest) return String(closest)
  }
  if (typeof interval === 'number' && Number.isFinite(interval) && interval > 0) {
    return String(Math.round(interval))
  }
  if (interval != null && typeof interval === 'string' && interval.trim()) {
    const t = interval.trim().toLowerCase()
    const n = Number(t)
    if (Number.isFinite(n) && n > 0) return String(Math.round(n))
    const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/)
    if (m && (m[1] || m[2] || m[3])) {
      const total = (m[1] ? parseInt(m[1]) * 3600 : 0) + (m[2] ? parseInt(m[2]) * 60 : 0) + (m[3] ? parseInt(m[3]) : 0)
      if (total > 0) return String(total)
    }
  }
  return '' // default
}

export function AgentSheet() {
  const open = useAppStore((s) => s.agentSheetOpen)
  const setOpen = useAppStore((s) => s.setAgentSheetOpen)
  const editingId = useAppStore((s) => s.editingAgentId)
  const setEditingId = useAppStore((s) => s.setEditingAgentId)
  const agents = useAppStore((s) => s.agents)
  const loadAgents = useAppStore((s) => s.loadAgents)
  const projects = useAppStore((s) => s.projects)
  const loadProjects = useAppStore((s) => s.loadProjects)
  const providers = useAppStore((s) => s.providers)
  const loadProviders = useAppStore((s) => s.loadProviders)
  const credentials = useAppStore((s) => s.credentials)
  const loadCredentials = useAppStore((s) => s.loadCredentials)
  const dynamicSkills = useAppStore((s) => s.skills)
  const mcpServers = useAppStore((s) => s.mcpServers)
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
  const [mcpServerIds, setMcpServerIds] = useState<string[]>([])
  const [mcpDisabledTools, setMcpDisabledTools] = useState<string[]>([])
  const [mcpTools, setMcpTools] = useState<Record<string, { name: string; description: string }[]>>({})
  const [mcpToolsLoading, setMcpToolsLoading] = useState(false)
  const [fallbackCredentialIds, setFallbackCredentialIds] = useState<string[]>([])
  const [platformAssignScope, setPlatformAssignScope] = useState<'self' | 'all'>('self')
  const [capabilities, setCapabilities] = useState<string[]>([])
  const [capInput, setCapInput] = useState('')
  const [ollamaMode, setOllamaMode] = useState<'local' | 'cloud'>('local')
  const [openclawEnabled, setOpenclawEnabled] = useState(false)
  const [projectId, setProjectId] = useState<string | undefined>(undefined)
  const [avatarSeed, setAvatarSeed] = useState('')
  const [thinkingLevel, setThinkingLevel] = useState<'' | 'minimal' | 'low' | 'medium' | 'high'>('')
  const [heartbeatEnabled, setHeartbeatEnabled] = useState(false)
  const [heartbeatIntervalSec, setHeartbeatIntervalSec] = useState('')  // '' = default (30m)
  const [heartbeatModel, setHeartbeatModel] = useState('')
  const [heartbeatPrompt, setHeartbeatPrompt] = useState('')
  const [addingKey, setAddingKey] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [newKeyValue, setNewKeyValue] = useState('')
  const [savingKey, setSavingKey] = useState(false)

  // Test connection state
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'pass' | 'fail'>('idle')
  const [testMessage, setTestMessage] = useState('')
  const [testErrorCode, setTestErrorCode] = useState<string | null>(null)
  const [testDeviceId, setTestDeviceId] = useState<string | null>(null)
  const [openclawDeviceId, setOpenclawDeviceId] = useState<string | null>(null)
  const [configCopied, setConfigCopied] = useState(false)

  const soulFileRef = useRef<HTMLInputElement>(null)
  const promptFileRef = useRef<HTMLInputElement>(null)
  const importFileRef = useRef<HTMLInputElement>(null)

  const handleFileUpload = (setter: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => setter(ev.target?.result as string)
    reader.readAsText(file)
    e.target.value = ''
  }

  const currentProvider = providers.find((p) => p.id === provider)
  const providerCredentials = Object.values(credentials).filter((c) => c.provider === provider)
  const openclawCredentials = Object.values(credentials).filter((c) => c.provider === 'openclaw')
  const editing = editingId ? agents[editingId] : null
  const hasNativeCapabilities = NATIVE_CAPABILITY_PROVIDER_IDS.has(provider)

  const providerNeedsKey = !editing && (
    (currentProvider?.requiresApiKey && providerCredentials.length === 0 && !addingKey) ||
    (provider === 'ollama' && ollamaMode === 'cloud' && providerCredentials.length === 0 && !addingKey)
  )

  useEffect(() => {
    if (open) {
      loadProviders()
      loadCredentials()
      loadSkills()
      loadProjects()
      loadClaudeSkills()
      setTestStatus('idle')
      setTestMessage('')
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
        setMcpServerIds(editing.mcpServerIds || [])
        setMcpDisabledTools(editing.mcpDisabledTools || [])
        setFallbackCredentialIds(editing.fallbackCredentialIds || [])
        setPlatformAssignScope(editing.platformAssignScope || 'self')
        setCapabilities(editing.capabilities || [])
        setCapInput('')
        setOllamaMode(editing.credentialId && editing.provider === 'ollama' ? 'cloud' : 'local')
        setOpenclawEnabled(editing.provider === 'openclaw')
        setProjectId(editing.projectId)
        setAvatarSeed(editing.avatarSeed || '')
        setThinkingLevel(editing.thinkingLevel || '')
        setHeartbeatEnabled(editing.heartbeatEnabled || false)
        setHeartbeatIntervalSec(parseDurationToSec(editing.heartbeatInterval, editing.heartbeatIntervalSec))
        setHeartbeatModel(editing.heartbeatModel || '')
        setHeartbeatPrompt(editing.heartbeatPrompt || '')
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
        setMcpDisabledTools([])
        setFallbackCredentialIds([])
        setPlatformAssignScope('self')
        setCapabilities([])
        setCapInput('')
        setOllamaMode('local')
        setOpenclawEnabled(false)
        setProjectId(undefined)
        setAvatarSeed('')
        setThinkingLevel('')
        setHeartbeatEnabled(false)
        setHeartbeatIntervalSec('')
        setHeartbeatModel('')
        setHeartbeatPrompt('')
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editingId])

  useEffect(() => {
    if (currentProvider?.models.length && !editing) {
      setModel(currentProvider.models[0])
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, providers])

  // Reset test status when connection params change
  useEffect(() => {
    setTestStatus('idle')
    setTestMessage('')
  }, [provider, credentialId, apiEndpoint])

  // Fetch MCP tools when selected servers change
  useEffect(() => {
    if (!mcpServerIds.length) {
      setMcpTools({})
      return
    }
    let cancelled = false
    setMcpToolsLoading(true)
    Promise.all(
      mcpServerIds.map(async (id) => {
        try {
          const tools = await api<{ name: string; description: string }[]>('GET', `/mcp-servers/${id}/tools`)
          return { id, tools: Array.isArray(tools) ? tools : [] }
        } catch {
          return { id, tools: [] }
        }
      })
    ).then((results) => {
      if (cancelled) return
      const map: Record<string, { name: string; description: string }[]> = {}
      for (const r of results) map[r.id] = r.tools
      setMcpTools(map)
      setMcpToolsLoading(false)
    })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mcpServerIds.join(',')])

  // Fetch OpenClaw device ID when toggle is enabled
  useEffect(() => {
    if (!openclawEnabled) return
    let cancelled = false
    api<{ deviceId: string }>('GET', '/setup/openclaw-device').then((res) => {
      if (!cancelled && res.deviceId) setOpenclawDeviceId(res.deviceId)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [openclawEnabled])

  const onClose = () => {
    setOpen(false)
    setEditingId(null)
  }

  const handleSave = async () => {
    // For any endpoint, just ensure bare host:port gets a protocol prepended
    let normalizedEndpoint = apiEndpoint
    if (normalizedEndpoint) {
      const url = normalizedEndpoint.trim().replace(/\/+$/, '')
      normalizedEndpoint = /^(https?|wss?):\/\//i.test(url) ? url : `http://${url}`
    }
    const data = {
      name: name.trim() || 'Unnamed Agent',
      description,
      soul,
      systemPrompt,
      provider,
      model,
      credentialId,
      apiEndpoint: normalizedEndpoint,
      isOrchestrator,
      subAgentIds: isOrchestrator ? subAgentIds : [],
      tools,
      skills,
      skillIds,
      mcpServerIds,
      mcpDisabledTools: mcpDisabledTools.length ? mcpDisabledTools : undefined,
      fallbackCredentialIds,
      platformAssignScope,
      capabilities,
      projectId: projectId || undefined,
      avatarSeed: avatarSeed.trim() || undefined,
      thinkingLevel: thinkingLevel || undefined,
      heartbeatEnabled,
      heartbeatInterval: heartbeatIntervalSec ? formatHbDuration(Number(heartbeatIntervalSec)) : null,
      heartbeatIntervalSec: heartbeatIntervalSec ? Number(heartbeatIntervalSec) : null,
      heartbeatModel: heartbeatModel.trim() || null,
      heartbeatPrompt: heartbeatPrompt.trim() || null,
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

  const handleExport = () => {
    if (!editing) return
    const { id: _id, createdAt: _ca, updatedAt: _ua, threadSessionId: _ts, ...exportData } = editing
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${editing.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.agent.json`
    a.click()
    URL.revokeObjectURL(url)
    toast.success('Agent exported')
  }

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = async (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string)
        // Strip IDs and timestamps
        const { id: _id, createdAt: _ca, updatedAt: _ua, threadSessionId: _ts, ...agentData } = data
        await createAgent({ ...agentData, name: agentData.name || 'Imported Agent' })
        await loadAgents()
        toast.success('Agent imported')
        onClose()
      } catch (err) {
        toast.error('Invalid agent JSON file')
      }
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  const handleTestConnection = async (): Promise<boolean> => {
    setTestStatus('testing')
    setTestMessage('')
    setTestErrorCode(null)
    try {
      const result = await api<{ ok: boolean; message: string; errorCode?: string; deviceId?: string }>('POST', '/setup/check-provider', {
        provider,
        credentialId,
        endpoint: apiEndpoint,
        model,
      })
      if (result.deviceId) setTestDeviceId(result.deviceId)
      if (result.ok) {
        setTestStatus('pass')
        setTestMessage(result.message)
        return true
      } else {
        setTestStatus('fail')
        setTestMessage(result.message)
        setTestErrorCode(result.errorCode || null)
        return false
      }
    } catch (err: unknown) {
      setTestStatus('fail')
      setTestMessage(err instanceof Error ? err.message : 'Connection test failed')
      return false
    }
  }

  // Whether this provider needs a connection test before saving.
  // Only CLI providers (no remote connection) skip the test.
  const needsTest = !providerNeedsKey && !NON_LANGGRAPH_PROVIDER_IDS.has(provider)

  const [saving, setSaving] = useState(false)

  const handleTestAndSave = async () => {
    if (needsTest) {
      const passed = await handleTestConnection()
      if (!passed) return
      if (!openclawEnabled) {
        // Brief pause so the user can see the success state on the button
        await new Promise((r) => setTimeout(r, 1500))
      }
    }
    setSaving(true)
    await handleSave()
    setSaving(false)
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
      <div className="mb-10 flex items-start justify-between">
        <div>
          <h2 className="font-display text-[28px] font-700 tracking-[-0.03em] mb-2">
            {editing ? 'Edit Agent' : 'New Agent'}
          </h2>
          <p className="text-[14px] text-text-3">Define an AI agent or orchestrator</p>
        </div>
        <div className="flex items-center gap-3 mt-1.5">
          <label className="text-[11px] font-600 text-text-3 uppercase tracking-[0.08em]">OpenClaw</label>
          <button
            type="button"
            onClick={() => {
              if (!openclawEnabled) {
                setOpenclawEnabled(true)
                setProvider('openclaw')
                setModel('default')
                if (!apiEndpoint) setApiEndpoint('http://localhost:18789')
              } else {
                setOpenclawEnabled(false)
                const first = providers[0]?.id || 'claude-cli'
                setProvider(first)
                setModel('')
                setApiEndpoint(null)
                setCredentialId(null)
                setTestStatus('idle')
                setTestMessage('')
                setTestErrorCode(null)
              }
            }}
            className={`relative w-11 h-6 rounded-full transition-colors duration-200 cursor-pointer border-none ${openclawEnabled ? 'bg-accent-bright' : 'bg-white/[0.12]'}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform duration-200 ${openclawEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
        </div>
      </div>

      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Name</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. SEO Researcher" className={inputClass} style={{ fontFamily: 'inherit' }} />
      </div>

      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Avatar</label>
        <div className="flex items-center gap-3">
          <AgentAvatar seed={avatarSeed || null} name={name || 'A'} size={40} />
          <input
            type="text"
            value={avatarSeed}
            onChange={(e) => setAvatarSeed(e.target.value)}
            placeholder="Avatar seed (any text)"
            className={inputClass}
            style={{ fontFamily: 'inherit', flex: 1 }}
          />
          <button
            type="button"
            onClick={() => setAvatarSeed(Math.random().toString(36).slice(2, 10))}
            className="px-3 py-2 rounded-[10px] border border-white/[0.08] bg-transparent text-text-3 text-[12px] font-600 cursor-pointer transition-all hover:bg-white/[0.04] shrink-0"
            style={{ fontFamily: 'inherit' }}
          >
            Randomize
          </button>
        </div>
      </div>

      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Description</label>
        <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What does this agent do?" className={inputClass} style={{ fontFamily: 'inherit' }} />
      </div>

      {/* Capabilities — hidden for OpenClaw (gateway manages its own capabilities) */}
      {!openclawEnabled && <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">
          Capabilities <span className="normal-case tracking-normal font-normal text-text-3">(for agent delegation)</span>
        </label>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {capabilities.map((cap) => (
            <span
              key={cap}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-[8px] bg-accent-soft text-accent-bright text-[12px] font-600"
            >
              {cap}
              <button
                onClick={() => setCapabilities((prev) => prev.filter((c) => c !== cap))}
                className="bg-transparent border-none text-accent-bright/60 hover:text-accent-bright cursor-pointer text-[14px] leading-none p-0"
              >
                x
              </button>
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={capInput}
            onChange={(e) => setCapInput(e.target.value)}
            onKeyDown={(e) => {
              if ((e.key === 'Enter' || e.key === ',') && capInput.trim()) {
                e.preventDefault()
                const val = capInput.trim().toLowerCase().replace(/,/g, '')
                if (val && !capabilities.includes(val)) {
                  setCapabilities((prev) => [...prev, val])
                }
                setCapInput('')
              }
            }}
            placeholder="e.g. frontend, research, devops"
            className={inputClass}
            style={{ fontFamily: 'inherit' }}
          />
        </div>
        <p className="text-[11px] text-text-3/70 mt-1.5">Press Enter or comma to add. Other agents see these when deciding delegation.</p>
      </div>}

      {/* Project */}
      {Object.keys(projects).length > 0 && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
            Project <span className="normal-case tracking-normal font-normal text-text-3">(optional)</span>
          </label>
          <select
            value={projectId || ''}
            onChange={(e) => setProjectId(e.target.value || undefined)}
            className={inputClass}
            style={{ fontFamily: 'inherit' }}
          >
            <option value="">None</option>
            {Object.values(projects).map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* Thinking Level */}
      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
          Thinking Level <span className="normal-case tracking-normal font-normal text-text-3">(optional)</span>
        </label>
        <select
          value={thinkingLevel}
          onChange={(e) => setThinkingLevel(e.target.value as typeof thinkingLevel)}
          className={inputClass}
          style={{ fontFamily: 'inherit' }}
        >
          <option value="">None (default)</option>
          <option value="minimal">Minimal — Direct and concise</option>
          <option value="low">Low — Brief reasoning</option>
          <option value="medium">Medium — Moderate analysis</option>
          <option value="high">High — Deep, thorough reasoning</option>
        </select>
        <p className="text-[11px] text-text-3/70 mt-1.5">Controls reasoning depth. Anthropic models use extended thinking; OpenAI o-series uses reasoning_effort. Others get system prompt guidance.</p>
      </div>

      {/* Heartbeat Configuration */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em]">Heartbeat</label>
          <button
            type="button"
            onClick={() => setHeartbeatEnabled(!heartbeatEnabled)}
            className={`relative w-10 h-[22px] rounded-full transition-colors duration-200 cursor-pointer ${heartbeatEnabled ? 'bg-accent' : 'bg-white/[0.12]'}`}
          >
            <span className={`absolute top-[3px] left-[3px] w-4 h-4 rounded-full bg-white transition-transform duration-200 ${heartbeatEnabled ? 'translate-x-[18px]' : ''}`} />
          </button>
        </div>
        {heartbeatEnabled && (
          <div className="space-y-4 mt-3">
            <div>
              <label className="block text-[12px] text-text-3/70 mb-1.5">Interval</label>
              <select
                value={heartbeatIntervalSec}
                onChange={(e) => setHeartbeatIntervalSec(e.target.value)}
                className={inputClass}
              >
                <option value="">Default (30m)</option>
                {HB_PRESETS.map((sec) => (
                  <option key={sec} value={String(sec)}>{formatHbDuration(sec)}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[12px] text-text-3/70 mb-1.5">Model override <span className="text-text-3/50">(optional, cheaper model)</span></label>
              <input
                type="text"
                value={heartbeatModel}
                onChange={(e) => setHeartbeatModel(e.target.value)}
                placeholder="e.g. gpt-4o-mini"
                className={inputClass}
                style={{ fontFamily: 'inherit' }}
              />
            </div>
            <div>
              <label className="block text-[12px] text-text-3/70 mb-1.5">Instructions <span className="text-text-3/50">(what to do each tick)</span></label>
              <textarea
                value={heartbeatPrompt}
                onChange={(e) => setHeartbeatPrompt(e.target.value)}
                placeholder="Describe what this agent should do during heartbeat ticks..."
                rows={4}
                className={`${inputClass} resize-y min-h-[100px]`}
                style={{ fontFamily: 'inherit' }}
              />
            </div>
          </div>
        )}
        <p className="text-[11px] text-text-3/70 mt-1.5">Periodic check-in runs on idle sessions using this agent. Processes pending events and monitors status.</p>
      </div>

      {provider !== 'openclaw' && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
            Soul / Personality <span className="normal-case tracking-normal font-normal text-text-3">(optional)</span>
          </label>
          <div className="flex items-center gap-2 mb-3">
            <p className="text-[12px] text-text-3/60">Define the agent&apos;s voice, tone, and personality. Injected before the system prompt.</p>
            <button onClick={() => soulFileRef.current?.click()} className="shrink-0 px-2 py-1 rounded-[8px] border border-white/[0.08] bg-surface text-[11px] text-text-3 hover:text-text-2 cursor-pointer transition-colors" style={{ fontFamily: 'inherit' }}>Upload .md</button>
            <input ref={soulFileRef} type="file" accept=".md,.txt,.markdown" onChange={handleFileUpload(setSoul)} className="hidden" />
          </div>
          <textarea
            value={soul}
            onChange={(e) => setSoul(e.target.value)}
            placeholder="e.g. You speak concisely and directly. You have a dry sense of humor. You always back claims with data."
            rows={3}
            className={`${inputClass} resize-y min-h-[80px]`}
            style={{ fontFamily: 'inherit' }}
          />
        </div>
      )}

      {provider !== 'openclaw' && (
        <div className="mb-8">
          <div className="flex items-center gap-2 mb-3">
            <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em]">System Prompt</label>
            <button onClick={() => promptFileRef.current?.click()} className="shrink-0 px-2 py-1 rounded-[8px] border border-white/[0.08] bg-surface text-[11px] text-text-3 hover:text-text-2 cursor-pointer transition-colors" style={{ fontFamily: 'inherit' }}>Upload .md</button>
            <input ref={promptFileRef} type="file" accept=".md,.txt,.markdown" onChange={handleFileUpload(setSystemPrompt)} className="hidden" />
          </div>
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="You are an expert..."
            rows={5}
            className={`${inputClass} resize-y min-h-[120px]`}
            style={{ fontFamily: 'inherit' }}
          />
        </div>
      )}

      {/* OpenClaw Gateway Fields */}
      {openclawEnabled && (
        <div className="mb-8 space-y-5">
          {/* Connection fields */}
          <div className="space-y-4">
            <div>
              <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">Gateway URL</label>
              <input
                type="text"
                value={apiEndpoint || ''}
                onChange={(e) => setApiEndpoint(e.target.value || null)}
                placeholder="http://localhost:18789"
                className={inputClass}
                style={{ fontFamily: 'inherit' }}
              />
            </div>
            <div>
              <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">Gateway Token</label>
              {openclawCredentials.length > 0 && !addingKey ? (
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
                    <option value="">No token (auth disabled)</option>
                    {openclawCredentials.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                    <option value="__add__">+ Add new token...</option>
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
                <div className="space-y-3 p-4 rounded-[12px] border border-accent-bright/15 bg-accent-soft/10">
                  <input
                    type="text"
                    value={newKeyName}
                    onChange={(e) => setNewKeyName(e.target.value)}
                    placeholder="Label (e.g. Local gateway)"
                    className={inputClass}
                    style={{ fontFamily: 'inherit' }}
                  />
                  <input
                    type="password"
                    value={newKeyValue}
                    onChange={(e) => setNewKeyValue(e.target.value)}
                    placeholder="Paste gateway token..."
                    className={inputClass}
                    style={{ fontFamily: 'inherit' }}
                  />
                  <div className="flex gap-2 justify-end">
                    {openclawCredentials.length > 0 && (
                      <button type="button" onClick={() => setAddingKey(false)} className="px-3 py-1.5 text-[12px] text-text-3 hover:text-text-2 transition-colors cursor-pointer bg-transparent border-none" style={{ fontFamily: 'inherit' }}>Cancel</button>
                    )}
                    <button
                      type="button"
                      disabled={savingKey || !newKeyValue.trim()}
                      onClick={async () => {
                        setSavingKey(true)
                        try {
                          const cred = await api<any>('POST', '/credentials', { provider: 'openclaw', name: newKeyName.trim() || 'OpenClaw token', apiKey: newKeyValue.trim() })
                          await loadCredentials()
                          setCredentialId(cred.id)
                          setAddingKey(false)
                          setNewKeyName('')
                          setNewKeyValue('')
                        } catch (err: any) { toast.error(`Failed to save: ${err.message}`) }
                        finally { setSavingKey(false) }
                      }}
                      className="px-4 py-1.5 rounded-[8px] bg-accent-bright text-white text-[12px] font-600 cursor-pointer border-none hover:brightness-110 transition-all disabled:opacity-40"
                      style={{ fontFamily: 'inherit' }}
                    >
                      {savingKey ? 'Saving...' : 'Save Token'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Insecure connection warning */}
          {(() => {
            const url = (apiEndpoint || '').trim().toLowerCase()
            const isRemote = url && !/localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/i.test(url)
            const isSecure = /^(https|wss):\/\//i.test(url)
            if (isRemote && !isSecure) return (
              <div className="px-3 py-2.5 rounded-[10px] bg-[#fbbf24]/[0.06] border border-[#fbbf24]/20">
                <p className="text-[13px] text-[#fbbf24] leading-[1.5]">
                  Unencrypted connection. Use HTTPS or an SSH tunnel for production.
                </p>
              </div>
            )
            return null
          })()}

          {/* Status feedback — single unified block */}
          {testStatus === 'pass' && (
            <div className="p-4 rounded-[12px] bg-emerald-500/[0.06] border border-emerald-500/15 space-y-2">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-400" />
                <p className="text-[14px] text-emerald-400 font-600">Connected</p>
              </div>
              <p className="text-[13px] text-text-2/80 leading-[1.6]">Gateway is reachable and this device is paired. Tools and models are managed by the OpenClaw instance.</p>
            </div>
          )}
          {testStatus === 'fail' && (
            <div className="p-4 rounded-[12px] border space-y-3"
              style={{
                background: testErrorCode === 'PAIRING_REQUIRED' ? 'rgba(34,197,94,0.04)' : 'rgba(var(--accent-bright-rgb,120,100,255),0.06)',
                borderColor: testErrorCode === 'PAIRING_REQUIRED' ? 'rgba(34,197,94,0.2)' : 'rgba(var(--accent-bright-rgb,120,100,255),0.15)',
              }}
            >
              {testErrorCode === 'PAIRING_REQUIRED' ? (<>
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <p className="text-[14px] text-[#22c55e] font-600">Awaiting Approval</p>
                </div>
                <p className="text-[13px] text-text-2/80 leading-[1.6]">
                  This device is pending approval on your gateway. Go to <span className="text-text-2 font-500">Nodes</span>, approve the device{(testDeviceId || openclawDeviceId) ? <> (<code className="text-[12px] font-mono text-text-2/70">{(testDeviceId || openclawDeviceId)!.slice(0, 12)}...</code>)</> : null}, then click <span className="text-text-2 font-500">Retry Connection</span>.
                </p>
                <a
                  href={(() => { const ep = (apiEndpoint || 'http://localhost:18789').replace(/\/+$/, ''); return /^https?:\/\//i.test(ep) ? ep : `http://${ep}` })()}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 mt-2 px-4 py-2 rounded-[10px] bg-white/[0.06] border border-white/[0.1] text-[13px] text-text-2 font-500 hover:bg-white/[0.1] transition-colors"
                >
                  Approve in Dashboard →
                </a>
              </>) : testErrorCode === 'DEVICE_AUTH_INVALID' ? (<>
                <p className="text-[14px] text-accent-bright font-600">Device Not Paired</p>
                <p className="text-[13px] text-text-2/80 leading-[1.6]">
                  The gateway doesn&apos;t recognize this device. Go to <span className="text-text-2 font-500">Nodes</span>, and add or approve this device{(testDeviceId || openclawDeviceId) ? <> (<code className="text-[12px] font-mono text-text-2/70">{(testDeviceId || openclawDeviceId)!.slice(0, 12)}...</code>)</> : null}.
                </p>
                <a
                  href={(() => { const ep = (apiEndpoint || 'http://localhost:18789').replace(/\/+$/, ''); return /^https?:\/\//i.test(ep) ? ep : `http://${ep}` })()}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 mt-2 px-4 py-2 rounded-[10px] bg-white/[0.06] border border-white/[0.1] text-[13px] text-text-2 font-500 hover:bg-white/[0.1] transition-colors"
                >
                  Approve in Dashboard →
                </a>
              </>) : testErrorCode === 'AUTH_TOKEN_MISSING' ? (<>
                <p className="text-[14px] text-accent-bright font-600">Token Required</p>
                <p className="text-[13px] text-text-2/80 leading-[1.6]">
                  This gateway requires an auth token. Add one above and try again.
                </p>
              </>) : testErrorCode === 'AUTH_TOKEN_INVALID' ? (<>
                <p className="text-[14px] text-accent-bright font-600">Invalid Token</p>
                <p className="text-[13px] text-text-2/80 leading-[1.6]">
                  The gateway rejected this token. Check that it matches the one configured on your OpenClaw instance.
                </p>
              </>) : (<>
                <p className="text-[14px] text-accent-bright font-600">Connection Failed</p>
                <p className="text-[13px] text-text-2/80 leading-[1.6]">
                  {testMessage || 'Could not reach the gateway. Check the URL, token, and that the gateway is running.'}
                </p>
              </>)}
              {/* Device ID footer — always shown on failure for debugging */}
              {(testDeviceId || openclawDeviceId) && testErrorCode !== 'AUTH_TOKEN_MISSING' && testErrorCode !== 'AUTH_TOKEN_INVALID' && (
                <div className="pt-2 border-t border-white/[0.04]">
                  <p className="text-[12px] text-text-3/70 flex items-center gap-1.5">
                    Device <code className="font-mono text-text-2/70 select-all">{(testDeviceId || openclawDeviceId)}</code>
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText((testDeviceId || openclawDeviceId)!)
                        setConfigCopied(true)
                        setTimeout(() => setConfigCopied(false), 2000)
                      }}
                      className="text-[12px] text-text-3/60 hover:text-text-3/80 transition-colors cursor-pointer bg-transparent border-none"
                    >
                      {configCopied ? 'copied' : 'copy'}
                    </button>
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {!openclawEnabled && <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Provider</label>
        <div className="grid grid-cols-3 gap-3">
          {providers.filter((p) => !isOrchestrator || p.id !== 'claude-cli').map((p) => {
            const isConnected = !p.requiresApiKey || Object.values(credentials).some((c) => c.provider === p.id)
            return (
              <button
                key={p.id}
                onClick={() => {
                  setProvider(p.id)
                }}
                className={`relative py-3.5 px-4 rounded-[14px] text-center cursor-pointer transition-all duration-200
                  active:scale-[0.97] text-[14px] font-600 border
                  ${provider === p.id
                    ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
                    : 'bg-surface border-white/[0.06] text-text-2 hover:bg-surface-2'}`}
                style={{ fontFamily: 'inherit' }}
              >
                {isConnected && (
                  <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-emerald-400" />
                )}
                {p.name}
              </button>
            )
          })}
        </div>
      </div>}

      {!openclawEnabled && currentProvider && currentProvider.models.length > 0 && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Model</label>
          <ModelCombobox
            providerId={currentProvider.id}
            value={model}
            onChange={setModel}
            models={currentProvider.models}
            defaultModels={currentProvider.defaultModels}
            className={`${inputClass} cursor-pointer`}
          />
        </div>
      )}

      {/* OpenClaw manages its own models — no selector needed */}

      {/* Ollama Mode Toggle */}
      {!openclawEnabled && provider === 'ollama' && (
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

      {!openclawEnabled && (currentProvider?.requiresApiKey || currentProvider?.optionalApiKey || (provider === 'ollama' && ollamaMode === 'cloud')) && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">
            API Key{currentProvider?.optionalApiKey && !currentProvider?.requiresApiKey && <span className="normal-case tracking-normal font-normal text-text-3"> (optional)</span>}
          </label>
          {providerCredentials.length > 0 && !addingKey ? (
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
                {providerCredentials.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
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
                {providerCredentials.length > 0 && (
                  <button type="button" onClick={() => setAddingKey(false)} className="px-3 py-1.5 text-[12px] text-text-3 hover:text-text-2 transition-colors cursor-pointer bg-transparent border-none" style={{ fontFamily: 'inherit' }}>Cancel</button>
                )}
                <button
                  type="button"
                  disabled={savingKey || !newKeyValue.trim()}
                  onClick={async () => {
                    setSavingKey(true)
                    try {
                      const cred = await api<any>('POST', '/credentials', { provider, name: newKeyName.trim() || `${provider} key`, apiKey: newKeyValue.trim() })
                      await loadCredentials()
                      setCredentialId(cred.id)
                      setAddingKey(false)
                      setNewKeyName('')
                      setNewKeyValue('')
                    } catch (err: any) { toast.error(`Failed to save: ${err.message}`) }
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

      {/* Fallback Credentials */}
      {!openclawEnabled && (currentProvider?.requiresApiKey || currentProvider?.optionalApiKey || (provider === 'ollama' && ollamaMode === 'cloud')) && providerCredentials.length > 1 && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
            Fallback Keys <span className="normal-case tracking-normal font-normal text-text-3">(for auto-failover)</span>
          </label>
          <p className="text-[12px] text-text-3/60 mb-3">If the primary key fails (rate limit, auth error), these keys will be tried in order.</p>
          <div className="flex flex-wrap gap-2">
            {providerCredentials.filter((c) => c.id !== credentialId).map((c) => {
              const active = fallbackCredentialIds.includes(c.id)
              return (
                <button
                  key={c.id}
                  onClick={() => setFallbackCredentialIds((prev) => active ? prev.filter((x) => x !== c.id) : [...prev, c.id])}
                  className={`px-3 py-2 rounded-[10px] text-[12px] font-600 cursor-pointer transition-all border
                    ${active
                      ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
                      : 'bg-surface border-white/[0.06] text-text-3 hover:text-text-2'}`}
                  style={{ fontFamily: 'inherit' }}
                >
                  {c.name}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {currentProvider?.requiresEndpoint && (provider === 'openclaw' || (provider === 'ollama' && ollamaMode === 'local')) && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">
            {provider === 'openclaw' ? 'OpenClaw Endpoint' : 'Endpoint'}
          </label>
          <input type="text" value={apiEndpoint || ''} onChange={(e) => setApiEndpoint(e.target.value || null)} placeholder={currentProvider.defaultEndpoint || 'http://localhost:11434'} className={`${inputClass} font-mono text-[14px]`} />
          {provider === 'openclaw' && (
            <p className="text-[13px] text-text-3/70 mt-2">The URL of your OpenClaw gateway</p>
          )}
        </div>
      )}

      {/* Tools — hidden for providers that manage capabilities outside LangGraph */}
      {!hasNativeCapabilities && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">Tools</label>
          <p className="text-[12px] text-text-3/60 mb-3">Enable tools for LangGraph agent sessions.</p>
          <div className="space-y-3">
            {AVAILABLE_TOOLS.map((t) => (
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
      )}

      {/* Platform — hidden for providers that manage capabilities outside LangGraph */}
      {!hasNativeCapabilities && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">Platform</label>
          <p className="text-[12px] text-text-3/60 mb-3">Allow this agent to manage platform resources directly.</p>
          <div className="space-y-3">
            {PLATFORM_TOOLS.map((t) => (
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
          {(tools.includes('manage_tasks') || tools.includes('manage_schedules')) && (
            <div className="mt-4 ml-1 pt-3 border-t border-white/[0.04]">
              <label className="flex items-center gap-3 cursor-pointer">
                <div
                  onClick={() => setPlatformAssignScope((prev) => prev === 'all' ? 'self' : 'all')}
                  className={`w-11 h-6 rounded-full transition-all duration-200 relative cursor-pointer shrink-0
                    ${platformAssignScope === 'all' ? 'bg-[#6366F1]' : 'bg-white/[0.08]'}`}
                >
                  <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200
                    ${platformAssignScope === 'all' ? 'left-[22px]' : 'left-0.5'}`} />
                </div>
                <span className="font-display text-[14px] font-600 text-text-2">Assign to Other Agents</span>
                <span className="text-[12px] text-text-3">Allow this agent to assign tasks and schedules to other agents</span>
              </label>
            </div>
          )}
        </div>
      )}

      {/* Native capability provider note — not shown for OpenClaw (covered in connection status) */}
      {hasNativeCapabilities && !openclawEnabled && (
        <div className="mb-8 p-4 rounded-[14px] bg-white/[0.02] border border-white/[0.06]">
          <p className="text-[13px] text-text-3">
            {provider === 'claude-cli'
              ? 'Claude CLI uses its own built-in capabilities — no additional local tool/platform configuration is needed.'
              : provider === 'codex-cli'
                ? 'OpenAI Codex CLI uses its own built-in tools (shell, files, etc.) — no additional local tool configuration needed.'
                : 'OpenCode CLI uses its own built-in tools (shell, files, etc.) — no additional local tool configuration needed.'}
          </p>
        </div>
      )}

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
            <p className="text-[12px] text-text-3/70">No skills found in ~/.claude/skills/</p>
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

      {/* MCP Servers */}
      {Object.keys(mcpServers).length > 0 && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
            MCP Servers
          </label>
          <p className="text-[12px] text-text-3/60 mb-3">Connect external tool servers to this agent via MCP.</p>
          <div className="flex flex-wrap gap-2">
            {Object.values(mcpServers).map((s: any) => {
              const active = mcpServerIds.includes(s.id)
              return (
                <button
                  key={s.id}
                  onClick={() => setMcpServerIds((prev) => active ? prev.filter((x) => x !== s.id) : [...prev, s.id])}
                  className={`px-3 py-2 rounded-[10px] text-[13px] font-600 cursor-pointer transition-all border
                    ${active
                      ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
                      : 'bg-surface border-white/[0.06] text-text-3 hover:text-text-2'}`}
                  style={{ fontFamily: 'inherit' }}
                  title={`${s.transport} — ${s.command || s.url || ''}`}
                >
                  {s.name}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* MCP Tools — per-tool enable/disable toggles */}
      {mcpServerIds.length > 0 && Object.keys(mcpTools).length > 0 && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
            MCP Tools
          </label>
          <p className="text-[12px] text-text-3/60 mb-3">
            Toggle individual tools from connected MCP servers.{mcpToolsLoading ? ' Loading…' : ''}
          </p>
          <div className="space-y-4">
            {mcpServerIds.map((serverId) => {
              const server = (mcpServers as Record<string, any>)[serverId]
              const serverTools = mcpTools[serverId]
              if (!server || !serverTools?.length) return null
              const safeName = server.name.replace(/[^a-zA-Z0-9_]/g, '_')
              return (
                <div key={serverId}>
                  <p className="text-[12px] font-600 text-text-3 mb-2">{server.name}</p>
                  <div className="space-y-3">
                    {serverTools.map((t) => {
                      const fullName = `mcp_${safeName}_${t.name}`
                      const enabled = !mcpDisabledTools.includes(fullName)
                      return (
                        <label key={fullName} className="flex items-center gap-3 cursor-pointer">
                          <div
                            onClick={() => setMcpDisabledTools((prev) =>
                              enabled ? [...prev, fullName] : prev.filter((x) => x !== fullName)
                            )}
                            className={`w-11 h-6 rounded-full transition-all duration-200 relative cursor-pointer shrink-0
                              ${enabled ? 'bg-[#6366F1]' : 'bg-white/[0.08]'}`}
                          >
                            <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200
                              ${enabled ? 'left-[22px]' : 'left-0.5'}`} />
                          </div>
                          <span className="font-display text-[14px] font-600 text-text-2">{t.name}</span>
                          <span className="text-[12px] text-text-3 truncate">{t.description}</span>
                        </label>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {provider !== 'openclaw' && (
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
      )}

      {provider !== 'openclaw' && isOrchestrator && agentOptions.length > 0 && (
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

      {/* Provider key warning */}
      {providerNeedsKey && (
        <div className="mb-4 p-3 rounded-[12px] bg-amber-500/[0.08] border border-amber-500/20">
          <p className="text-[13px] text-amber-400">
            Add an API key for {currentProvider?.name || provider} above before creating this agent.
          </p>
        </div>
      )}

      {/* Test connection result (hidden for OpenClaw — inline status block handles it) */}
      {!openclawEnabled && testStatus === 'fail' && (
        <div className="mb-4 p-3 rounded-[12px] bg-red-500/[0.08] border border-red-500/20">
          <p className="text-[13px] text-red-400">{testMessage || 'Connection test failed'}</p>
        </div>
      )}
      {!openclawEnabled && testStatus === 'pass' && (
        <div className="mb-4 p-3 rounded-[12px] bg-emerald-500/[0.08] border border-emerald-500/20">
          <p className="text-[13px] text-emerald-400">{testMessage || 'Connected successfully'}</p>
        </div>
      )}

      {/* Import file input (hidden) */}
      <input ref={importFileRef} type="file" accept=".json" onChange={handleImport} className="hidden" />

      <div className="flex gap-3 pt-2 border-t border-white/[0.04]">
        {editing && (
          <button onClick={handleDelete} className="py-3.5 px-6 rounded-[14px] border border-red-500/20 bg-transparent text-red-400 text-[15px] font-600 cursor-pointer hover:bg-red-500/10 transition-all" style={{ fontFamily: 'inherit' }}>
            Delete
          </button>
        )}
        {editing && (
          <button onClick={handleExport} className="py-3.5 px-4 rounded-[14px] border border-white/[0.08] bg-transparent text-text-3 text-[13px] font-600 cursor-pointer hover:bg-surface-2 hover:text-text-2 transition-all" style={{ fontFamily: 'inherit' }} title="Export agent as JSON">
            Export
          </button>
        )}
        {!editing && (
          <button onClick={() => importFileRef.current?.click()} className="py-3.5 px-4 rounded-[14px] border border-white/[0.08] bg-transparent text-text-3 text-[13px] font-600 cursor-pointer hover:bg-surface-2 hover:text-text-2 transition-all" style={{ fontFamily: 'inherit' }} title="Import agent from JSON">
            Import
          </button>
        )}
        <button onClick={onClose} className="flex-1 py-3.5 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[15px] font-600 cursor-pointer hover:bg-surface-2 transition-all" style={{ fontFamily: 'inherit' }}>
          Cancel
        </button>
        <button
          onClick={handleTestAndSave}
          disabled={!name.trim() || providerNeedsKey || testStatus === 'testing' || saving || (!openclawEnabled && testStatus === 'pass')}
          className={`flex-1 py-3.5 rounded-[14px] border-none text-white text-[15px] font-600 cursor-pointer active:scale-[0.97] disabled:opacity-60 transition-all hover:brightness-110
            ${testStatus === 'pass' ? 'bg-emerald-600 shadow-[0_4px_20px_rgba(16,185,129,0.25)]' : 'bg-[#6366F1] shadow-[0_4px_20px_rgba(99,102,241,0.25)]'}`}
          style={{ fontFamily: 'inherit' }}
        >
          {openclawEnabled
            ? (testStatus === 'testing' ? 'Connecting...'
              : testStatus === 'pass' ? (saving ? 'Saving...' : 'Save')
              : testStatus === 'fail' && testErrorCode === 'PAIRING_REQUIRED' ? 'Retry Connection'
              : testStatus === 'fail' ? 'Retry'
              : 'Connect')
            : (testStatus === 'testing' ? 'Testing...' : testStatus === 'pass' ? (saving ? 'Saving...' : 'Connected!') : needsTest ? 'Test & Save' : editing ? 'Save' : 'Create')}
        </button>
      </div>
    </BottomSheet>
  )
}

