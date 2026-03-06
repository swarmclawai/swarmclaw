'use client'

import { DEFAULT_HEARTBEAT_INTERVAL_SEC } from '@/lib/heartbeat-defaults'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { Agent } from '@/types'
import { useAppStore } from '@/stores/use-app-store'
import { AgentAvatar } from './agent-avatar'
import { AgentFilesEditor } from './agent-files-editor'
import { OpenClawSkillsPanel } from './openclaw-skills-panel'
import { PermissionPresetSelector } from './permission-preset-selector'
import { ExecConfigPanel } from './exec-config-panel'
import { SandboxEnvPanel } from './sandbox-env-panel'
import { CronJobForm } from './cron-job-form'

interface Props {
  agent: Agent
  onEditAgent?: () => void
  onClearHistory?: () => void
  onDeleteAgent?: () => void
  onDeleteChat?: () => void
  isMainChat?: boolean
}

type InspectorTab = 'overview' | 'files' | 'skills' | 'automations' | 'advanced'

const TABS: { id: InspectorTab; label: string; openclawOnly?: boolean }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'files', label: 'Files', openclawOnly: true },
  { id: 'skills', label: 'Skills' },
  { id: 'automations', label: 'Automations' },
  { id: 'advanced', label: 'Advanced' },
]

const PROVIDER_LABELS: Record<string, string> = {
  'claude-cli': 'Claude CLI',
  'codex-cli': 'Codex CLI',
  'opencode-cli': 'OpenCode CLI',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  openclaw: 'OpenClaw',
  ollama: 'Ollama',
}

function panelCardClass(className = '') {
  return `rounded-[16px] border border-white/[0.06] bg-white/[0.03] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] ${className}`.trim()
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <label className="block text-[11px] font-700 uppercase tracking-[0.16em] text-text-3/45 mb-2">{children}</label>
}

export function InspectorPanel({ agent, onEditAgent, onClearHistory, onDeleteAgent, onDeleteChat, isMainChat }: Props) {
  const inspectorTab = useAppStore((s) => s.inspectorTab)
  const setInspectorTab = useAppStore((s) => s.setInspectorTab)
  const setInspectorOpen = useAppStore((s) => s.setInspectorOpen)
  const schedules = useAppStore((s) => s.schedules)

  const isOpenClaw = agent.provider === 'openclaw'
  const visibleTabs = TABS.filter((t) => !t.openclawOnly || isOpenClaw)

  // Reset to overview if current tab is not visible
  useEffect(() => {
    if (!visibleTabs.find((t) => t.id === inspectorTab)) {
      setInspectorTab('overview')
    }
  }, [isOpenClaw]) // eslint-disable-next-line react-hooks/exhaustive-deps

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setInspectorOpen(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [setInspectorOpen])

  const agentSchedules = Object.values(schedules).filter((s) => s.agentId === agent.id)
  const providerLabel = PROVIDER_LABELS[agent.provider] || agent.provider.replace(/-/g, ' ')

  return (
    <div className="w-[420px] shrink-0 border-l border-white/[0.06] bg-bg flex flex-col h-full overflow-hidden fade-up-delay"
      style={{ background: 'radial-gradient(circle at top right, rgba(66, 211, 255, 0.06), transparent 30%), linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0))' }}>
      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-b border-white/[0.06] shrink-0 bg-black/[0.12]">
        <div className="flex items-start gap-3">
          <AgentAvatar seed={agent.avatarSeed || null} avatarUrl={agent.avatarUrl} name={agent.name} size={40} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <h3 className="font-display text-[16px] font-700 text-text truncate tracking-[-0.02em]">{agent.name}</h3>
              {agent.heartbeatEnabled && (
                <span className="inline-flex items-center gap-1 rounded-[7px] border border-emerald-400/15 bg-emerald-400/10 px-2 py-0.5 text-[10px] font-700 uppercase tracking-[0.12em] text-emerald-300">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                  Heartbeat
                </span>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center rounded-[8px] border border-white/[0.06] bg-white/[0.03] px-2 py-1 text-[10px] font-600 text-text-3/70">
                {providerLabel}
              </span>
              <span className="inline-flex max-w-[180px] items-center rounded-[8px] border border-white/[0.06] bg-white/[0.03] px-2 py-1 text-[10px] font-mono text-text-3/70 truncate">
                {agent.model || 'Default model'}
              </span>
              <span className="inline-flex items-center rounded-[8px] border border-white/[0.06] bg-white/[0.03] px-2 py-1 text-[10px] font-600 text-text-3/70">
                {(agent.plugins?.length ?? 0)} plugins
              </span>
            </div>
          </div>
        <button
          onClick={() => setInspectorOpen(false)}
          className="p-1.5 rounded-[8px] text-text-3/50 hover:text-text-3 bg-transparent border-none cursor-pointer transition-all hover:bg-white/[0.04]"
          aria-label="Close inspector"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="px-4 py-3 shrink-0">
      <div className="flex gap-1 rounded-[12px] border border-white/[0.06] bg-black/[0.12] p-1 overflow-x-auto" role="tablist">
        {visibleTabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            onClick={() => setInspectorTab(tab.id)}
            aria-selected={inspectorTab === tab.id}
            className={`px-3 py-1.5 rounded-[9px] text-[11px] font-700 cursor-pointer transition-all whitespace-nowrap focus-visible:ring-1 focus-visible:ring-accent-bright/50
              ${inspectorTab === tab.id
                ? 'bg-white/[0.08] text-text'
                : 'bg-transparent text-text-3/65 hover:text-text-2'}`}
            style={{ fontFamily: 'inherit' }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {inspectorTab === 'overview' && (
          <OverviewTab
            agent={agent}
            onEditAgent={onEditAgent}
            onClearHistory={onClearHistory}
            onDeleteAgent={onDeleteAgent}
            onDeleteChat={onDeleteChat}
            isMainChat={isMainChat}
          />
        )}
        {inspectorTab === 'files' && isOpenClaw && (
          <AgentFilesEditor agentId={agent.id} />
        )}
        {inspectorTab === 'skills' && (
          isOpenClaw ? (
            <OpenClawSkillsPanel
              agentId={agent.id}
              initialMode={agent.openclawSkillMode}
              initialAllowed={agent.openclawAllowedSkills}
            />
          ) : (
            <div className="p-4 text-[13px] text-text-3/50">
              Local skills are configured in the agent editor.
            </div>
          )
        )}
        {inspectorTab === 'automations' && (
          <AutomationsTab schedules={agentSchedules} agent={agent} />
        )}
        {inspectorTab === 'advanced' && (
          <AdvancedTab agent={agent} />
        )}
      </div>
    </div>
  )
}

interface OverviewTabProps {
  agent: Agent
  onEditAgent?: () => void
  onClearHistory?: () => void
  onDeleteAgent?: () => void
  onDeleteChat?: () => void
  isMainChat?: boolean
}

function OverviewTab({ agent, onEditAgent, onClearHistory, onDeleteAgent, onDeleteChat, isMainChat }: OverviewTabProps) {
  const summaryStats = [
    { label: 'Provider', value: PROVIDER_LABELS[agent.provider] || agent.provider.replace(/-/g, ' ') },
    { label: 'Model', value: agent.model || 'Default' },
    { label: 'Plugins', value: String(agent.plugins?.length ?? 0) },
    { label: 'Heartbeat', value: agent.heartbeatEnabled ? `Every ${agent.heartbeatIntervalSec ?? DEFAULT_HEARTBEAT_INTERVAL_SEC}s` : 'Off' },
  ]

  return (
    <div className="p-4 flex flex-col gap-4">
      <div className={panelCardClass('p-4 bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.02))]')}>
        <SectionLabel>Overview</SectionLabel>
        <p className="text-[14px] text-text-2 leading-relaxed">
          {agent.description || 'No description yet. Use the agent editor to define what this agent is for.'}
        </p>
        <div className="mt-4 grid grid-cols-2 gap-2">
          {summaryStats.map((item) => (
            <div key={item.label} className="rounded-[12px] border border-white/[0.06] bg-black/[0.14] px-3 py-2.5">
              <div className="text-[10px] font-700 uppercase tracking-[0.14em] text-text-3/45">{item.label}</div>
              <div className="mt-1 text-[12px] text-text-2 font-medium break-words">{item.value}</div>
            </div>
          ))}
        </div>
      </div>
      {agent.systemPrompt && (
        <div className={panelCardClass('p-4')}>
          <SectionLabel>System Prompt</SectionLabel>
          <p className="text-[12px] text-text-3 bg-black/[0.14] rounded-[12px] p-3 border border-white/[0.04] max-h-[220px] overflow-y-auto whitespace-pre-wrap font-mono leading-relaxed">
            {agent.systemPrompt}
          </p>
        </div>
      )}
      {agent.capabilities && agent.capabilities.length > 0 && (
        <div className={panelCardClass('p-4')}>
          <SectionLabel>Capabilities</SectionLabel>
          <div className="flex flex-wrap gap-1.5">
            {agent.capabilities.map((cap) => (
              <span key={cap} className="px-2.5 py-1 rounded-[8px] text-[11px] font-700 bg-accent-soft/70 text-accent-bright border border-accent-bright/10">
                {cap}
              </span>
            ))}
          </div>
        </div>
      )}
      {agent.plugins && agent.plugins.length > 0 && (
        <div className={panelCardClass('p-4')}>
          <SectionLabel>Plugins</SectionLabel>
          <div className="flex flex-wrap gap-1.5">
            {agent.plugins.map((tool) => (
              <span key={tool} className="px-2.5 py-1 rounded-[8px] text-[11px] font-700 bg-sky-400/[0.08] text-sky-300 border border-sky-400/[0.08]">
                {tool}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      {(onEditAgent || onClearHistory || onDeleteAgent || onDeleteChat) && (
        <div className={panelCardClass('p-4')}>
          <SectionLabel>Actions</SectionLabel>
          <div className="flex flex-col gap-2">
            {onEditAgent && (
              <button
                onClick={onEditAgent}
                className="w-full px-3 py-2.5 rounded-[10px] text-[12px] font-700 text-accent-bright bg-accent-soft/50 border border-accent-bright/10 cursor-pointer transition-all hover:bg-accent-soft text-left"
                style={{ fontFamily: 'inherit' }}
              >
                Edit Agent
              </button>
            )}
            {(onClearHistory || onDeleteAgent || onDeleteChat) && (
              <>
                <SectionLabel>Danger Zone</SectionLabel>
                <div className="flex flex-col gap-1.5">
                  {onClearHistory && (
                    <button
                      onClick={onClearHistory}
                      className="w-full px-3 py-2.5 rounded-[10px] text-[12px] font-700 text-red-400/80 bg-red-400/[0.04] border border-red-400/[0.08] cursor-pointer transition-all hover:bg-red-400/[0.08] hover:text-red-400 text-left"
                      style={{ fontFamily: 'inherit' }}
                    >
                      Clear History
                    </button>
                  )}
                  {onDeleteAgent && !isMainChat && (
                    <button
                      onClick={onDeleteAgent}
                      className="w-full px-3 py-2.5 rounded-[10px] text-[12px] font-700 text-red-400/80 bg-red-400/[0.04] border border-red-400/[0.08] cursor-pointer transition-all hover:bg-red-400/[0.08] hover:text-red-400 text-left"
                      style={{ fontFamily: 'inherit' }}
                    >
                      Delete Agent
                    </button>
                  )}
                  {onDeleteChat && !isMainChat && (
                    <button
                      onClick={onDeleteChat}
                      className="w-full px-3 py-2.5 rounded-[10px] text-[12px] font-700 text-red-400/80 bg-red-400/[0.04] border border-red-400/[0.08] cursor-pointer transition-all hover:bg-red-400/[0.08] hover:text-red-400 text-left"
                      style={{ fontFamily: 'inherit' }}
                    >
                      Delete Chat
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function AutomationsTab({ schedules, agent }: { schedules: Array<{ id: string; name: string; status: string; cron?: string; scheduleType: string }>; agent: Agent }) {
  const isOpenClaw = agent.provider === 'openclaw'
  const [gatewayCrons, setGatewayCrons] = useState<Array<{ id: string; name: string; enabled: boolean; schedule?: { kind: string; value: string }; state?: { nextRun?: string; lastRun?: string } }>>([])
  const [cronLoading, setCronLoading] = useState(false)
  const [showCronForm, setShowCronForm] = useState(false)

  const loadCrons = useCallback(async () => {
    if (!isOpenClaw) return
    setCronLoading(true)
    try {
      const { api } = await import('@/lib/api-client')
      const crons = await api<Array<{ id: string; name: string; enabled: boolean; schedule?: { kind: string; value: string }; state?: { nextRun?: string; lastRun?: string } }>>('GET', '/openclaw/cron')
      setGatewayCrons(crons.filter((c) => (c as Record<string, unknown>).agentId === agent.id))
    } catch { /* ignore */ }
    finally { setCronLoading(false) }
  }, [isOpenClaw, agent.id])

  useEffect(() => { loadCrons() }, [loadCrons])

  const handleRunCron = async (id: string) => {
    try {
      const { api } = await import('@/lib/api-client')
      await api('POST', '/openclaw/cron', { action: 'run', id })
    } catch { /* ignore */ }
  }

  const handleRemoveCron = async (id: string) => {
    try {
      const { api } = await import('@/lib/api-client')
      await api('POST', '/openclaw/cron', { action: 'remove', id })
      setGatewayCrons((prev) => prev.filter((c) => c.id !== id))
    } catch { /* ignore */ }
  }

  return (
    <div className="p-4 flex flex-col gap-3">
      {/* Local schedules */}
      {schedules.map((s) => (
        <div key={s.id} className={panelCardClass('py-2.5 px-3.5')}>
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-600 text-text truncate flex-1">{s.name}</span>
            <span className={`text-[10px] font-600 uppercase tracking-wider px-1.5 py-0.5 rounded-[4px]
              ${s.status === 'active' ? 'text-emerald-400 bg-emerald-400/[0.08]' : 'text-text-3/50 bg-white/[0.02]'}`}>
              {s.status}
            </span>
          </div>
          <div className="text-[11px] text-text-3/50 mt-1">
            {s.scheduleType}{s.cron ? ` (${s.cron})` : ''}
          </div>
        </div>
      ))}

      {/* Gateway cron jobs */}
      {isOpenClaw && (
        <>
          {cronLoading && <div className="text-[12px] text-text-3/50">Loading gateway crons...</div>}
          {gatewayCrons.map((c) => (
            <div key={c.id} className={panelCardClass('py-2.5 px-3.5')}>
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-600 text-text truncate flex-1">{c.name}</span>
                <span className={`text-[10px] font-600 uppercase tracking-wider px-1.5 py-0.5 rounded-[4px]
                  ${c.enabled ? 'text-emerald-400 bg-emerald-400/[0.08]' : 'text-text-3/50 bg-white/[0.02]'}`}>
                  {c.enabled ? 'active' : 'disabled'}
                </span>
              </div>
              <div className="text-[11px] text-text-3/50 mt-1">
                {c.schedule?.kind} {c.schedule?.value}
                {c.state?.nextRun && ` — next: ${c.state.nextRun}`}
              </div>
              <div className="flex gap-2 mt-2">
                <button onClick={() => handleRunCron(c.id)} className="text-[10px] text-accent-bright bg-transparent border-none cursor-pointer hover:underline">Run Now</button>
                <button onClick={() => handleRemoveCron(c.id)} className="text-[10px] text-red-400/70 bg-transparent border-none cursor-pointer hover:underline">Delete</button>
              </div>
            </div>
          ))}
          {showCronForm ? (
            <CronJobForm agentId={agent.id} onSaved={() => { setShowCronForm(false); loadCrons() }} onCancel={() => setShowCronForm(false)} />
          ) : (
            <button
              onClick={() => setShowCronForm(true)}
              className="self-start px-3 py-1.5 rounded-[8px] border border-dashed border-white/[0.08] bg-transparent text-text-3 text-[12px] font-600 cursor-pointer transition-all hover:border-white/[0.15] hover:text-text-2"
              style={{ fontFamily: 'inherit' }}
            >
              + Add Cron Job
            </button>
          )}
        </>
      )}

      {!schedules.length && !gatewayCrons.length && !cronLoading && !showCronForm && (
        <div className={panelCardClass('p-4 text-[13px] text-text-3/50')}>No automations linked to this agent.</div>
      )}
    </div>
  )
}

function AdvancedTab({ agent }: { agent: Agent }) {
  const isOpenClaw = agent.provider === 'openclaw'

  return (
    <div className="p-4 flex flex-col gap-4">
      {/* Permission Presets + Exec Config + Sandbox Env (OpenClaw only) */}
      {isOpenClaw && (
        <>
          <PermissionPresetSelector agentId={agent.id} />
          <div className="border-t border-white/[0.06] pt-4">
            <ExecConfigPanel agentId={agent.id} />
          </div>
          <div className="border-t border-white/[0.06] pt-4">
            <SandboxEnvPanel />
          </div>
        </>
      )}

      {agent.heartbeatEnabled && (
        <div className={panelCardClass('p-4')}>
          <SectionLabel>Heartbeat</SectionLabel>
          <p className="text-[13px] text-text-2">
            Every {agent.heartbeatIntervalSec ?? DEFAULT_HEARTBEAT_INTERVAL_SEC}s
            {agent.heartbeatModel && ` (${agent.heartbeatModel})`}
          </p>
        </div>
      )}
      {agent.thinkingLevel && (
        <div className={panelCardClass('p-4')}>
          <SectionLabel>Thinking Level</SectionLabel>
          <p className="text-[13px] text-text-2 capitalize">{agent.thinkingLevel}</p>
        </div>
      )}
      <div className={panelCardClass('p-4')}>
        <SectionLabel>Agent ID</SectionLabel>
        <p className="text-[12px] text-text-3 font-mono select-all">{agent.id}</p>
      </div>
      <div className={panelCardClass('p-4')}>
        <SectionLabel>Created</SectionLabel>
        <p className="text-[12px] text-text-3">{new Date(agent.createdAt).toLocaleString()}</p>
      </div>
      <div className={panelCardClass('p-4')}>
        <SectionLabel>Updated</SectionLabel>
        <p className="text-[12px] text-text-3">{new Date(agent.updatedAt).toLocaleString()}</p>
      </div>
    </div>
  )
}
