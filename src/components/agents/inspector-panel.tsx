'use client'

import { useCallback, useEffect, useState } from 'react'
import type { Agent } from '@/types'
import { useAppStore } from '@/stores/use-app-store'
import { AgentFilesEditor } from './agent-files-editor'
import { OpenClawSkillsPanel } from './openclaw-skills-panel'
import { PermissionPresetSelector } from './permission-preset-selector'
import { ExecConfigPanel } from './exec-config-panel'
import { SandboxEnvPanel } from './sandbox-env-panel'
import { CronJobForm } from './cron-job-form'

interface Props {
  agent: Agent
}

type InspectorTab = 'overview' | 'files' | 'skills' | 'automations' | 'advanced'

const TABS: { id: InspectorTab; label: string; openclawOnly?: boolean }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'files', label: 'Files', openclawOnly: true },
  { id: 'skills', label: 'Skills' },
  { id: 'automations', label: 'Automations' },
  { id: 'advanced', label: 'Advanced' },
]

export function InspectorPanel({ agent }: Props) {
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

  return (
    <div className="w-[400px] shrink-0 border-l border-white/[0.06] bg-[#0d0f1a] flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06] shrink-0">
        <h3 className="font-display text-[14px] font-600 text-text truncate">{agent.name}</h3>
        <button
          onClick={() => setInspectorOpen(false)}
          className="p-1 rounded-[6px] text-text-3/50 hover:text-text-3 bg-transparent border-none cursor-pointer transition-all hover:bg-white/[0.04]"
          aria-label="Close inspector"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Tab bar */}
      <div className="flex gap-0.5 px-3 pt-2 pb-1 overflow-x-auto shrink-0">
        {visibleTabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setInspectorTab(tab.id)}
            className={`px-2.5 py-1.5 rounded-[8px] text-[11px] font-600 cursor-pointer transition-all whitespace-nowrap
              ${inspectorTab === tab.id
                ? 'bg-accent-soft text-accent-bright'
                : 'bg-transparent text-text-3 hover:text-text-2'}`}
            style={{ fontFamily: 'inherit' }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {inspectorTab === 'overview' && (
          <OverviewTab agent={agent} />
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

function OverviewTab({ agent }: { agent: Agent }) {
  return (
    <div className="p-4 flex flex-col gap-4">
      <div>
        <label className="block text-[11px] font-600 uppercase tracking-wider text-text-3/50 mb-1">Description</label>
        <p className="text-[13px] text-text-2">{agent.description || 'No description'}</p>
      </div>
      <div>
        <label className="block text-[11px] font-600 uppercase tracking-wider text-text-3/50 mb-1">Provider / Model</label>
        <p className="text-[13px] text-text-2 font-mono">{agent.provider} / {agent.model || 'default'}</p>
      </div>
      {agent.systemPrompt && (
        <div>
          <label className="block text-[11px] font-600 uppercase tracking-wider text-text-3/50 mb-1">System Prompt</label>
          <p className="text-[12px] text-text-3 bg-white/[0.02] rounded-[8px] p-2.5 border border-white/[0.04] max-h-[200px] overflow-y-auto whitespace-pre-wrap font-mono">
            {agent.systemPrompt}
          </p>
        </div>
      )}
      {agent.capabilities && agent.capabilities.length > 0 && (
        <div>
          <label className="block text-[11px] font-600 uppercase tracking-wider text-text-3/50 mb-1">Capabilities</label>
          <div className="flex flex-wrap gap-1">
            {agent.capabilities.map((cap) => (
              <span key={cap} className="px-2 py-0.5 rounded-[6px] text-[11px] font-600 bg-accent-soft text-accent-bright">
                {cap}
              </span>
            ))}
          </div>
        </div>
      )}
      {agent.tools && agent.tools.length > 0 && (
        <div>
          <label className="block text-[11px] font-600 uppercase tracking-wider text-text-3/50 mb-1">Tools</label>
          <div className="flex flex-wrap gap-1">
            {agent.tools.map((tool) => (
              <span key={tool} className="px-2 py-0.5 rounded-[6px] text-[11px] font-600 bg-sky-400/[0.08] text-sky-400/70">
                {tool}
              </span>
            ))}
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
        <div key={s.id} className="py-2 px-3 rounded-[10px] bg-white/[0.02] border border-white/[0.04]">
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
            <div key={c.id} className="py-2 px-3 rounded-[10px] bg-white/[0.02] border border-white/[0.04]">
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
        <div className="text-[13px] text-text-3/50">No automations linked to this agent.</div>
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
        <div>
          <label className="block text-[11px] font-600 uppercase tracking-wider text-text-3/50 mb-1">Heartbeat</label>
          <p className="text-[13px] text-text-2">
            Every {agent.heartbeatIntervalSec ?? 120}s
            {agent.heartbeatModel && ` (${agent.heartbeatModel})`}
          </p>
        </div>
      )}
      {agent.thinkingLevel && (
        <div>
          <label className="block text-[11px] font-600 uppercase tracking-wider text-text-3/50 mb-1">Thinking Level</label>
          <p className="text-[13px] text-text-2 capitalize">{agent.thinkingLevel}</p>
        </div>
      )}
      <div>
        <label className="block text-[11px] font-600 uppercase tracking-wider text-text-3/50 mb-1">Agent ID</label>
        <p className="text-[12px] text-text-3 font-mono select-all">{agent.id}</p>
      </div>
      <div>
        <label className="block text-[11px] font-600 uppercase tracking-wider text-text-3/50 mb-1">Created</label>
        <p className="text-[12px] text-text-3">{new Date(agent.createdAt).toLocaleString()}</p>
      </div>
      <div>
        <label className="block text-[11px] font-600 uppercase tracking-wider text-text-3/50 mb-1">Updated</label>
        <p className="text-[12px] text-text-3">{new Date(agent.updatedAt).toLocaleString()}</p>
      </div>
    </div>
  )
}
