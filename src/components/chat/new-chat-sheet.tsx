'use client'

import { useState, useMemo } from 'react'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import { SectionLabel } from '@/components/shared/section-label'
import { useAppStore } from '@/stores/use-app-store'
import { api } from '@/lib/api-client'
import { PROVIDERS } from '@/lib/providers'
import { TOOL_LABELS, TOOL_DESCRIPTIONS } from '@/components/chat/tool-call-bubble'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import { genId } from '@/lib/id'
import type { ProviderType, SessionTool } from '@/types'

interface Props {
  open: boolean
  onClose: () => void
}

export function NewChatSheet({ open, onClose }: Props) {
  const router = useRouter()
  const agents = useAppStore((s) => s.agents)
  const loadSessions = useAppStore((s) => s.loadSessions)

  const [selectedAgentId, setSelectedAgentId] = useState<string>('')
  const [provider, setProvider] = useState<ProviderType>('openai')
  const [model, setModel] = useState<string>('')
  const [endpoint, setEndpoint] = useState('')
  const [selectedTools, setSelectedTools] = useState<SessionTool[]>([])
  const [loading, setLoading] = useState(false)

  const agentList = useMemo(() => Object.values(agents).sort((a, b) => b.updatedAt - a.updatedAt), [agents])
  const currentProvider = PROVIDERS[provider]

  const reset = () => {
    setSelectedAgentId('')
    setProvider('openai')
    setModel('')
    setEndpoint('')
    setSelectedTools([])
  }

  const handleCreate = async () => {
    setLoading(true)
    try {
      const agent = selectedAgentId ? agents[selectedAgentId] : null
      const id = genId(8)
      const now = Date.now()

      const agentTools = agent?.plugins || (selectedTools.length ? selectedTools : undefined)

      const session = {
        id,
        name: agent ? `Chat with ${agent.name}` : `New Session (${model || provider})`,
        provider: agent ? agent.provider : provider,
        model: agent ? agent.model : model,
        apiEndpoint: agent ? agent.apiEndpoint : (endpoint || undefined),
        credentialId: agent ? agent.credentialId : undefined,
        plugins: agentTools || undefined,
        messages: [],
        createdAt: now,
        updatedAt: now,
        active: true,
        agentId: selectedAgentId || undefined,
      }

      await api('POST', '/chats', session)
      await loadSessions()
      router.push(`/chat?session=${id}`)
      onClose()
      reset()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to create session')
    } finally {
      setLoading(false)
    }
  }

  const inputClass = "w-full py-3 px-4 rounded-[14px] bg-surface border border-white/[0.06] text-text placeholder:text-text-3/50 outline-none focus:border-accent-bright/30 transition-all"

  return (
    <BottomSheet open={open} onClose={onClose}>
      <div className="mb-10">
        <h2 className="font-display text-[28px] font-700 tracking-[-0.03em] mb-2">New Session</h2>
        <p className="text-[14px] text-text-3">Start a new conversation with an agent or a direct model.</p>
      </div>

      <div className="mb-8">
        <SectionLabel>Select Agent</SectionLabel>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <button
            onClick={() => setSelectedAgentId('')}
            className={`flex flex-col items-center justify-center gap-2 p-4 rounded-[18px] border transition-all duration-200 cursor-pointer
              ${!selectedAgentId 
                ? 'bg-accent-soft border-accent-bright/25 text-accent-bright shadow-[0_0_25px_rgba(99,102,241,0.12)]' 
                : 'bg-surface border-white/[0.06] text-text-3 hover:bg-surface-2 hover:border-white/[0.08]'}`}
          >
            <div className={`w-10 h-10 rounded-full flex items-center justify-center ${!selectedAgentId ? 'bg-accent-bright/20' : 'bg-white/[0.04]'}`}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
              </svg>
            </div>
            <span className="text-[13px] font-600">Direct Model</span>
          </button>

          {agentList.map((a) => (
            <button
              key={a.id}
              onClick={() => setSelectedAgentId(a.id)}
              className={`flex flex-col items-center justify-center gap-2 p-4 rounded-[18px] border transition-all duration-200 cursor-pointer
                ${selectedAgentId === a.id 
                  ? 'bg-accent-soft border-accent-bright/25 text-accent-bright shadow-[0_0_25px_rgba(99,102,241,0.12)]' 
                  : 'bg-surface border-white/[0.06] text-text-3 hover:bg-surface-2 hover:border-white/[0.08]'}`}
            >
              <div className="w-10 h-10 rounded-full bg-accent-bright/10 overflow-hidden">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`https://api.dicebear.com/7.x/bottts-neutral/svg?seed=${a.avatarSeed || a.id}`} alt="" />
              </div>
              <span className="text-[13px] font-600 truncate w-full text-center px-1">{a.name}</span>
            </button>
          ))}
        </div>
      </div>

      {!selectedAgentId && (
        <>
          <div className="grid grid-cols-2 gap-4 mb-6">
            <div>
              <SectionLabel>Provider</SectionLabel>
              <select
                value={provider}
                onChange={(e) => {
                  const p = e.target.value as ProviderType
                  setProvider(p)
                  setModel(PROVIDERS[p].models[0])
                }}
                className={`${inputClass} appearance-none cursor-pointer`}
                style={{ fontFamily: 'inherit' }}
              >
                {Object.values(PROVIDERS).map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div>
              <SectionLabel>Model</SectionLabel>
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
          </div>

          {currentProvider.requiresEndpoint && (
            <div className="mb-8">
              <SectionLabel>{provider === 'openclaw' ? 'OpenClaw Endpoint' : 'Endpoint'}</SectionLabel>
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

          {/* Plugins (Capability enablement) */}
          <div className="mb-8">
            <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">
              Plugins <span className="normal-case tracking-normal font-normal text-text-3">(optional)</span>
            </label>
            <p className="text-[12px] text-text-3/60 mb-3">Allow this model to execute commands and access files.</p>
            <div className="flex flex-wrap gap-2.5">
              {([
                { id: 'shell' as SessionTool, label: 'Shell' },
                { id: 'files' as SessionTool, label: 'Files' },
                { id: 'edit_file' as SessionTool, label: 'Edit File' },
                { id: 'web_search' as SessionTool, label: 'Web Search' },
                { id: 'web_fetch' as SessionTool, label: 'Web Fetch' },
                { id: 'claude_code' as SessionTool, label: 'Claude Code' },
                { id: 'codex_cli' as SessionTool, label: 'Codex CLI' },
                { id: 'opencode_cli' as SessionTool, label: 'OpenCode CLI' },
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
        </>
      )}

      {/* Summary when agent selected */}
      {selectedAgentId && agents[selectedAgentId] && (
        <div className="mb-8 px-4 py-3 rounded-[14px] bg-surface border border-white/[0.06]">
          <span className="text-[13px] text-text-3">
            Using <span className="text-text-2 font-600">{agents[selectedAgentId].provider}</span>
            {' / '}
            <span className="text-text-2 font-600">{agents[selectedAgentId].model}</span>
            {agents[selectedAgentId].plugins?.length ? (
              <>
                {' + '}
                {agents[selectedAgentId].plugins!.map((tool, i) => (
                  <span key={tool}>
                    {i > 0 && ', '}
                    <span className="text-sky-400/70 font-600 cursor-help" title={TOOL_DESCRIPTIONS[tool] || tool}>
                      {TOOL_LABELS[tool] || tool.replace(/_/g, ' ')}
                    </span>
                  </span>
                ))}
              </>
            ) : null}
          </span>
        </div>
      )}

      <button
        onClick={handleCreate}
        disabled={loading || (!selectedAgentId && !model)}
        className="w-full py-4 rounded-[18px] bg-accent-bright text-white font-display text-[15px] font-700 shadow-[0_0_30px_rgba(56,189,248,0.3)] hover:shadow-[0_0_40px_rgba(56,189,248,0.45)] hover:scale-[1.01] active:scale-[0.99] transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100 disabled:shadow-none"
        style={{ fontFamily: 'inherit' }}
      >
        {loading ? 'Creating...' : 'Start Session'}
      </button>
    </BottomSheet>
  )
}
