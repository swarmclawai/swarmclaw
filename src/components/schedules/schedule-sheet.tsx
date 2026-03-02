'use client'

import { useEffect, useState, useMemo } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { createSchedule, updateSchedule, deleteSchedule } from '@/lib/schedules'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import { AgentPickerList } from '@/components/shared/agent-picker-list'
import { inputClass } from '@/components/shared/form-styles'
import type { ScheduleType, ScheduleStatus } from '@/types'
import cronstrue from 'cronstrue'
import { SectionLabel } from '@/components/shared/section-label'

const CRON_PRESETS = [
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Daily at 9am', cron: '0 9 * * *' },
  { label: 'Weekly Mon 9am', cron: '0 9 * * 1' },
]

async function getNextRunsAsync(cron: string, count: number = 3): Promise<Date[]> {
  try {
    const { CronExpressionParser } = await import('cron-parser')
    const interval = CronExpressionParser.parse(cron)
    const runs: Date[] = []
    for (let i = 0; i < count; i++) {
      runs.push(interval.next().toDate())
    }
    return runs
  } catch {
    return []
  }
}

function formatCronHuman(cron: string): string {
  try {
    return cronstrue.toString(cron, { use24HourTimeFormat: false })
  } catch {
    return 'Invalid cron expression'
  }
}

function formatDate(d: Date): string {
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const STEPS = ['What', 'When', 'Review'] as const
type Step = 0 | 1 | 2

export function ScheduleSheet() {
  const open = useAppStore((s) => s.scheduleSheetOpen)
  const setOpen = useAppStore((s) => s.setScheduleSheetOpen)
  const editingId = useAppStore((s) => s.editingScheduleId)
  const setEditingId = useAppStore((s) => s.setEditingScheduleId)
  const schedules = useAppStore((s) => s.schedules)
  const loadSchedules = useAppStore((s) => s.loadSchedules)
  const agents = useAppStore((s) => s.agents)
  const loadAgents = useAppStore((s) => s.loadAgents)

  const [step, setStep] = useState<Step>(0)
  const [name, setName] = useState('')
  const [agentId, setAgentId] = useState('')
  const [taskPrompt, setTaskPrompt] = useState('')
  const [scheduleType, setScheduleType] = useState<ScheduleType>('cron')
  const [cron, setCron] = useState('0 * * * *')
  const [intervalMs, setIntervalMs] = useState(3600000)
  const [status, setStatus] = useState<ScheduleStatus>('active')
  const [customCron, setCustomCron] = useState(false)

  const editing = editingId ? schedules[editingId] : null
  const agentList = Object.values(agents).sort((a, b) => a.name.localeCompare(b.name))

  useEffect(() => {
    if (open) {
      loadAgents()
      setStep(0)
      if (editing) {
        setName(editing.name || '')
        setAgentId(editing.agentId)
        setTaskPrompt(editing.taskPrompt)
        setScheduleType(editing.scheduleType)
        setCron(editing.cron || '0 * * * *')
        setIntervalMs(editing.intervalMs || 3600000)
        setStatus(editing.status)
        setCustomCron(!CRON_PRESETS.some((p) => p.cron === editing.cron))
      } else {
        setName('')
        setAgentId('')
        setTaskPrompt('')
        setScheduleType('cron')
        setCron('0 * * * *')
        setIntervalMs(3600000)
        setStatus('active')
        setCustomCron(false)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editingId])

  const cronHuman = useMemo(() => formatCronHuman(cron), [cron])
  const [nextRuns, setNextRuns] = useState<Date[]>([])
  useEffect(() => {
    getNextRunsAsync(cron).then(setNextRuns)
  }, [cron])

  const onClose = () => {
    setOpen(false)
    setEditingId(null)
  }

  const handleSave = async () => {
    const data = {
      name: name.trim(),
      agentId,
      taskPrompt,
      scheduleType,
      cron: scheduleType === 'cron' ? cron : undefined,
      intervalMs: scheduleType === 'interval' ? intervalMs : undefined,
      runAt: scheduleType === 'once' ? Date.now() + intervalMs : undefined,
      status,
    }
    if (editing) {
      await updateSchedule(editing.id, data)
    } else {
      await createSchedule(data)
    }
    await loadSchedules()
    onClose()
  }

  const handleDelete = async () => {
    if (editing) {
      await deleteSchedule(editing.id)
      await loadSchedules()
      onClose()
    }
  }

  // Step validation
  const step0Valid = name.trim().length > 0 && agentId.length > 0 && taskPrompt.trim().length > 0
  const step1Valid = scheduleType === 'cron' ? cron.trim().length > 0 : intervalMs > 0

  const selectedAgent = agentId ? agents[agentId] : null

  return (
    <BottomSheet open={open} onClose={onClose} wide>
      <div className="mb-8">
        <h2 className="font-display text-[28px] font-700 tracking-[-0.03em] mb-2">
          {editing ? 'Edit Schedule' : 'New Schedule'}
        </h2>
        <p className="text-[14px] text-text-3">Automate agent tasks on a schedule</p>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-10">
        {STEPS.map((label, i) => (
          <div key={label} className="flex items-center gap-2">
            {i > 0 && <div className={`w-8 h-px ${i <= step ? 'bg-accent-bright/40' : 'bg-white/[0.06]'}`} />}
            <button
              onClick={() => {
                // Allow going back, but only forward if valid
                if (i < step) setStep(i as Step)
                else if (i === 1 && step === 0 && step0Valid) setStep(1)
                else if (i === 2 && step === 1 && step1Valid) setStep(2)
              }}
              className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-[8px] text-[12px] font-600 cursor-pointer transition-all border-none
                ${i === step
                  ? 'bg-accent-soft text-accent-bright'
                  : i < step
                    ? 'bg-white/[0.04] text-text-2'
                    : 'bg-transparent text-text-3/50'}`}
              style={{ fontFamily: 'inherit' }}
            >
              <span className={`w-5 h-5 rounded-full text-[10px] font-700 flex items-center justify-center
                ${i === step
                  ? 'bg-accent-bright text-white'
                  : i < step
                    ? 'bg-emerald-400/20 text-emerald-400'
                    : 'bg-white/[0.06] text-text-3/50'}`}>
                {i < step ? (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12" /></svg>
                ) : (
                  i + 1
                )}
              </span>
              {label}
            </button>
          </div>
        ))}
      </div>

      {/* Step 0: What */}
      {step === 0 && (
        <div>
          <div className="mb-8">
            <SectionLabel>Name</SectionLabel>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Daily keyword research" className={inputClass} style={{ fontFamily: 'inherit' }} />
          </div>

          <div className="mb-8">
            <SectionLabel>Agent</SectionLabel>
            <AgentPickerList
              agents={agentList}
              selected={agentId}
              onSelect={(id) => setAgentId(id)}
              showOrchBadge={true}
            />
          </div>

          <div className="mb-8">
            <SectionLabel>Task Prompt</SectionLabel>
            <textarea
              value={taskPrompt}
              onChange={(e) => setTaskPrompt(e.target.value)}
              placeholder="What should the agent do when triggered?"
              rows={4}
              className={`${inputClass} resize-y min-h-[100px]`}
              style={{ fontFamily: 'inherit' }}
            />
          </div>
        </div>
      )}

      {/* Step 1: When */}
      {step === 1 && (
        <div>
          <div className="mb-8">
            <SectionLabel>Schedule Type</SectionLabel>
            <div className="grid grid-cols-3 gap-3">
              {(['cron', 'interval', 'once'] as ScheduleType[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setScheduleType(t)}
                  className={`py-3.5 px-4 rounded-[14px] text-center cursor-pointer transition-all duration-200
                    active:scale-[0.97] text-[14px] font-600 capitalize border
                    ${scheduleType === t
                      ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
                      : 'bg-surface border-white/[0.06] text-text-2 hover:bg-surface-2'}`}
                  style={{ fontFamily: 'inherit' }}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {scheduleType === 'cron' && (
            <div className="mb-8">
              <SectionLabel>Schedule</SectionLabel>

              {/* Preset buttons */}
              <div className="flex flex-wrap gap-2 mb-4">
                {CRON_PRESETS.map((p) => (
                  <button
                    key={p.cron}
                    onClick={() => { setCron(p.cron); setCustomCron(false) }}
                    className={`px-3.5 py-2 rounded-[10px] text-[13px] font-600 cursor-pointer transition-all border
                      ${cron === p.cron && !customCron
                        ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
                        : 'bg-surface border-white/[0.06] text-text-3 hover:text-text-2'}`}
                    style={{ fontFamily: 'inherit' }}
                  >
                    {p.label}
                  </button>
                ))}
                <button
                  onClick={() => setCustomCron(true)}
                  className={`px-3.5 py-2 rounded-[10px] text-[13px] font-600 cursor-pointer transition-all border
                    ${customCron
                      ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
                      : 'bg-surface border-white/[0.06] text-text-3 hover:text-text-2'}`}
                  style={{ fontFamily: 'inherit' }}
                >
                  Custom
                </button>
              </div>

              {/* Custom cron input */}
              {customCron && (
                <input type="text" value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 * * * *" className={`${inputClass} font-mono text-[14px] mb-3`} />
              )}

              {/* Human-readable preview */}
              <div className="p-4 rounded-[14px] bg-surface border border-white/[0.06]">
                <div className="text-[14px] text-text-2 font-600 mb-2">{cronHuman}</div>
                {cron && (
                  <div className="font-mono text-[12px] text-text-3/50 mb-3">{cron}</div>
                )}
                {nextRuns.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-[11px] text-text-3/60 uppercase tracking-wider font-600">Next runs</div>
                    {nextRuns.map((d, i) => (
                      <div key={i} className="text-[12px] text-text-3 font-mono">{formatDate(d)}</div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {scheduleType === 'interval' && (
            <div className="mb-8">
              <SectionLabel>Interval (minutes)</SectionLabel>
              <input
                type="number"
                value={Math.round(intervalMs / 60000)}
                onChange={(e) => setIntervalMs(Math.max(1, parseInt(e.target.value) || 1) * 60000)}
                className={inputClass}
                style={{ fontFamily: 'inherit' }}
              />
            </div>
          )}

          {editing && (
            <div className="mb-8">
              <SectionLabel>Status</SectionLabel>
              <div className="flex gap-2">
                {(['active', 'paused'] as ScheduleStatus[]).map((s) => (
                  <button
                    key={s}
                    onClick={() => setStatus(s)}
                    className={`px-4 py-2 rounded-[10px] text-[13px] font-600 capitalize cursor-pointer transition-all border
                      ${status === s
                        ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
                        : 'bg-surface border-white/[0.06] text-text-3'}`}
                    style={{ fontFamily: 'inherit' }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Step 2: Review */}
      {step === 2 && (
        <div className="mb-8">
          <div className="p-5 rounded-[16px] bg-surface border border-white/[0.06] space-y-4">
            <div>
              <span className="text-[11px] text-text-3/50 uppercase tracking-wider font-600">Name</span>
              <div className="text-[14px] text-text font-600 mt-0.5">{name}</div>
            </div>
            <div>
              <span className="text-[11px] text-text-3/50 uppercase tracking-wider font-600">Agent</span>
              <div className="text-[14px] text-text font-600 mt-0.5">{selectedAgent?.name || agentId}</div>
            </div>
            <div>
              <span className="text-[11px] text-text-3/50 uppercase tracking-wider font-600">Task</span>
              <div className="text-[13px] text-text-2 mt-0.5 whitespace-pre-wrap">{taskPrompt}</div>
            </div>
            <div className="h-px bg-white/[0.06]" />
            <div>
              <span className="text-[11px] text-text-3/50 uppercase tracking-wider font-600">Schedule</span>
              <div className="text-[14px] text-text font-600 mt-0.5 capitalize">{scheduleType}</div>
              {scheduleType === 'cron' && (
                <div className="text-[12px] text-text-3 font-mono mt-0.5">{cronHuman} ({cron})</div>
              )}
              {scheduleType === 'interval' && (
                <div className="text-[12px] text-text-3 font-mono mt-0.5">Every {Math.round(intervalMs / 60000)} minutes</div>
              )}
              {scheduleType === 'once' && (
                <div className="text-[12px] text-text-3 font-mono mt-0.5">Run once</div>
              )}
            </div>
            {editing && (
              <div>
                <span className="text-[11px] text-text-3/50 uppercase tracking-wider font-600">Status</span>
                <div className="text-[14px] text-text font-600 mt-0.5 capitalize">{status}</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="flex gap-3 pt-2 border-t border-white/[0.04]">
        {editing && step === 0 && (
          <button onClick={handleDelete} className="py-3.5 px-6 rounded-[14px] border border-red-500/20 bg-transparent text-red-400 text-[15px] font-600 cursor-pointer hover:bg-red-500/10 transition-all" style={{ fontFamily: 'inherit' }}>
            Delete
          </button>
        )}
        {step > 0 && (
          <button
            onClick={() => setStep((step - 1) as Step)}
            className="py-3.5 px-6 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[15px] font-600 cursor-pointer hover:bg-surface-2 transition-all"
            style={{ fontFamily: 'inherit' }}
          >
            Back
          </button>
        )}
        <div className="flex-1" />
        <button
          onClick={onClose}
          className="py-3.5 px-6 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[15px] font-600 cursor-pointer hover:bg-surface-2 transition-all"
          style={{ fontFamily: 'inherit' }}
        >
          Cancel
        </button>
        {step < 2 ? (
          <button
            onClick={() => setStep((step + 1) as Step)}
            disabled={step === 0 ? !step0Valid : !step1Valid}
            className="py-3.5 px-8 rounded-[14px] border-none bg-accent-bright text-white text-[15px] font-600 cursor-pointer active:scale-[0.97] disabled:opacity-30 transition-all shadow-[0_4px_20px_rgba(99,102,241,0.25)] hover:brightness-110"
            style={{ fontFamily: 'inherit' }}
          >
            Next
          </button>
        ) : (
          <button
            onClick={handleSave}
            className="py-3.5 px-8 rounded-[14px] border-none bg-accent-bright text-white text-[15px] font-600 cursor-pointer active:scale-[0.97] transition-all shadow-[0_4px_20px_rgba(99,102,241,0.25)] hover:brightness-110"
            style={{ fontFamily: 'inherit' }}
          >
            {editing ? 'Save' : 'Create'}
          </button>
        )}
      </div>
    </BottomSheet>
  )
}
