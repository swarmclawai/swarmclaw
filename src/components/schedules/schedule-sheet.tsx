'use client'

import { useEffect, useState, useMemo } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { createSchedule, updateSchedule, deleteSchedule } from '@/lib/schedules/schedules'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import { AgentPickerList } from '@/components/shared/agent-picker-list'
import { ConfirmDialog } from '@/components/shared/confirm-dialog'
import { inputClass } from '@/components/shared/form-styles'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import type { ScheduleType, ScheduleStatus } from '@/types'
import cronstrue from 'cronstrue'
import { SectionLabel } from '@/components/shared/section-label'
import { SCHEDULE_TEMPLATES, type ScheduleTemplate } from '@/lib/schedules/schedule-templates'
import { HintTip } from '@/components/shared/hint-tip'
import { isUserCreatedSchedule } from '@/lib/schedules/schedule-origin'
import { toast } from 'sonner'
import {
  Newspaper, BarChart3, HeartPulse, PenLine, Trash2,
  Activity, ShieldCheck, DatabaseBackup, FileText,
} from 'lucide-react'

const TEMPLATE_ICONS: Record<string, React.ComponentType<{ className?: string; size?: number }>> = {
  Newspaper, BarChart3, HeartPulse, PenLine, Trash2,
  Activity, ShieldCheck, DatabaseBackup, FileText,
}

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

const STEPS_CREATE = ['Template', 'What', 'When', 'Review'] as const
const STEPS_EDIT = ['What', 'When', 'Review'] as const
type Step = 0 | 1 | 2 | 3

function applyTemplate(
  tpl: ScheduleTemplate,
  setters: {
    setName: (v: string) => void
    setTaskPrompt: (v: string) => void
    setScheduleType: (v: ScheduleType) => void
    setCron: (v: string) => void
    setIntervalMs: (v: number) => void
    setCustomCron: (v: boolean) => void
  },
) {
  setters.setName(tpl.name)
  setters.setTaskPrompt(tpl.defaults.taskPrompt)
  setters.setScheduleType(tpl.defaults.scheduleType)
  if (tpl.defaults.cron) {
    setters.setCron(tpl.defaults.cron)
    setters.setCustomCron(!CRON_PRESETS.some((p) => p.cron === tpl.defaults.cron))
  }
  if (tpl.defaults.intervalMs) setters.setIntervalMs(tpl.defaults.intervalMs)
}

export function ScheduleSheet() {
  const open = useAppStore((s) => s.scheduleSheetOpen)
  const setOpen = useAppStore((s) => s.setScheduleSheetOpen)
  const editingId = useAppStore((s) => s.editingScheduleId)
  const setEditingId = useAppStore((s) => s.setEditingScheduleId)
  const schedules = useAppStore((s) => s.schedules)
  const loadSchedules = useAppStore((s) => s.loadSchedules)
  const agents = useAppStore((s) => s.agents)
  const loadAgents = useAppStore((s) => s.loadAgents)
  const templatePrefill = useAppStore((s) => s.scheduleTemplatePrefill)
  const setTemplatePrefill = useAppStore((s) => s.setScheduleTemplatePrefill)

  const [step, setStep] = useState<Step>(0)
  const [name, setName] = useState('')
  const [agentId, setAgentId] = useState('')
  const [taskPrompt, setTaskPrompt] = useState('')
  const [scheduleType, setScheduleType] = useState<ScheduleType>('cron')
  const [cron, setCron] = useState('0 * * * *')
  const [intervalMs, setIntervalMs] = useState(3600000)
  const [status, setStatus] = useState<ScheduleStatus>('active')
  const [taskMode, setTaskMode] = useState<'task' | 'wake_only'>('task')
  const [message, setMessage] = useState('')
  const [customCron, setCustomCron] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const editing = editingId ? schedules[editingId] : null
  const isCreating = !editing
  const steps = isCreating ? STEPS_CREATE : STEPS_EDIT
  const agentList = Object.values(agents).sort((a, b) => a.name.localeCompare(b.name))

  // Compute which logical step we're on (template step only exists in create mode)
  const templateStep = isCreating ? 0 : -1
  const whatStep = isCreating ? 1 : 0
  const whenStep = isCreating ? 2 : 1
  const reviewStep = isCreating ? 3 : 2

  useEffect(() => {
    if (open) {
      loadAgents()
      if (editing) {
        setStep(0)
        setName(editing.name || '')
        setAgentId(editing.agentId)
        setTaskPrompt(editing.taskPrompt)
        setScheduleType(editing.scheduleType)
        setCron(editing.cron || '0 * * * *')
        setIntervalMs(editing.intervalMs || 3600000)
        setStatus(editing.status)
        setTaskMode(editing.taskMode === 'wake_only' ? 'wake_only' : 'task')
        setMessage(editing.message || '')
        setCustomCron(!CRON_PRESETS.some((p) => p.cron === editing.cron))
      } else if (templatePrefill) {
        // Opened from a quick-start card with pre-filled values
        setName(templatePrefill.name)
        setTaskPrompt(templatePrefill.taskPrompt)
        setScheduleType(templatePrefill.scheduleType)
        if (templatePrefill.cron) {
          setCron(templatePrefill.cron)
          setCustomCron(!CRON_PRESETS.some((p) => p.cron === templatePrefill.cron))
        }
        if (templatePrefill.intervalMs) setIntervalMs(templatePrefill.intervalMs)
        setAgentId('')
        setStatus('active')
        setStep(1) // Skip template picker, go to "What" step
        setTemplatePrefill(null)
      } else {
        setStep(0) // Start at template picker
        setName('')
        setAgentId('')
        setTaskPrompt('')
        setScheduleType('cron')
        setCron('0 * * * *')
        setIntervalMs(3600000)
        setStatus('active')
        setTaskMode('task')
        setMessage('')
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
    setConfirmDelete(false)
    setDeleting(false)
    setOpen(false)
    setEditingId(null)
  }

  const handleSave = async () => {
    const data = {
      name: name.trim(),
      agentId,
      taskPrompt: taskMode === 'wake_only' ? message : taskPrompt,
      taskMode,
      message: taskMode === 'wake_only' ? message : undefined,
      scheduleType,
      cron: scheduleType === 'cron' ? cron : undefined,
      intervalMs: scheduleType === 'interval' ? intervalMs : undefined,
      runAt: scheduleType === 'once' ? Date.now() + intervalMs : undefined,
      status,
    }
    try {
      if (editing) {
        await updateSchedule(editing.id, data)
        toast.success('Schedule updated successfully')
      } else {
        await createSchedule(data)
        toast.success('Schedule created successfully')
      }
      await loadSchedules()
      onClose()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to save schedule')
    }
  }

  const handleDelete = async () => {
    if (!editing) return
    setDeleting(true)
    try {
      await deleteSchedule(editing.id)
      toast.success('Schedule deleted')
      await loadSchedules()
      setConfirmDelete(false)
      onClose()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete schedule')
    } finally {
      setDeleting(false)
    }
  }

  // Step validation
  const step0Valid = name.trim().length > 0 && agentId.length > 0 && (taskMode === 'wake_only' ? message.trim().length > 0 : taskPrompt.trim().length > 0)
  const step1Valid = scheduleType === 'cron' ? cron.trim().length > 0 : intervalMs > 0

  const selectedAgent = agentId ? agents[agentId] : null
  const creatorAgent = editing?.createdByAgentId ? agents[editing.createdByAgentId] : null

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
        {steps.map((label, i) => (
          <div key={label} className="flex items-center gap-2">
            {i > 0 && <div className={`w-8 h-px ${i <= step ? 'bg-accent-bright/40' : 'bg-white/[0.06]'}`} />}
            <button
              onClick={() => {
                if (i < step) setStep(i as Step)
                else if (i === step + 1) {
                  if (step === whatStep && step0Valid) setStep(i as Step)
                  else if (step === whenStep && step1Valid) setStep(i as Step)
                  else if (step === templateStep) setStep(i as Step)
                }
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

      {/* Template Picker (create only) */}
      {step === templateStep && isCreating && (
        <div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
            {SCHEDULE_TEMPLATES.map((tpl) => {
              const IconComp = TEMPLATE_ICONS[tpl.icon] || FileText
              return (
                <button
                  key={tpl.id}
                  onClick={() => {
                    const setters = { setName, setTaskPrompt, setScheduleType, setCron, setIntervalMs, setCustomCron }
                    applyTemplate(tpl, setters)
                    setStep(whatStep as Step)
                  }}
                  className="flex items-start gap-3.5 p-4 rounded-[14px] border border-white/[0.06] bg-surface
                    text-left cursor-pointer transition-all duration-200 hover:bg-surface-2 hover:border-white/[0.1]
                    active:scale-[0.98]"
                  style={{ fontFamily: 'inherit' }}
                >
                  <div className="w-9 h-9 rounded-[10px] bg-accent-soft flex items-center justify-center shrink-0 mt-0.5">
                    <IconComp size={16} className="text-accent-bright" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[14px] font-600 text-text mb-0.5">{tpl.name}</div>
                    <div className="text-[12px] text-text-3/70 leading-[1.4]">{tpl.description}</div>
                    <div className="mt-1.5 text-[11px] text-text-3/40 capitalize">{tpl.category}</div>
                  </div>
                </button>
              )
            })}
          </div>
          <button
            onClick={() => setStep(whatStep as Step)}
            className="w-full py-3.5 rounded-[14px] border border-dashed border-white/[0.08] bg-transparent
              text-text-3 text-[14px] font-600 cursor-pointer transition-all hover:bg-surface hover:text-text-2 hover:border-white/[0.12]"
            style={{ fontFamily: 'inherit' }}
          >
            Start from scratch
          </button>
        </div>
      )}

      {/* Step: What */}
      {step === whatStep && (
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
            <div className="flex items-center gap-2 mb-3">
              <SectionLabel className="mb-0">Task Mode</SectionLabel>
              <HintTip text="Create task: creates a board task for the agent. Wake agent only: sends a message to the agent without creating a task." />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => setTaskMode('task')}
                className={`py-3 px-4 rounded-[14px] text-center cursor-pointer transition-all duration-200
                  active:scale-[0.97] text-[14px] font-600 border
                  ${taskMode === 'task'
                    ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
                    : 'bg-surface border-white/[0.06] text-text-2 hover:bg-surface-2'}`}
                style={{ fontFamily: 'inherit' }}
              >
                Create task
              </button>
              <button
                onClick={() => setTaskMode('wake_only')}
                className={`py-3 px-4 rounded-[14px] text-center cursor-pointer transition-all duration-200
                  active:scale-[0.97] text-[14px] font-600 border
                  ${taskMode === 'wake_only'
                    ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
                    : 'bg-surface border-white/[0.06] text-text-2 hover:bg-surface-2'}`}
                style={{ fontFamily: 'inherit' }}
              >
                Wake agent only
              </button>
            </div>
          </div>

          {taskMode === 'wake_only' ? (
            <div className="mb-8">
              <SectionLabel>Wake Message</SectionLabel>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Message to send to the agent when woken"
                rows={4}
                className={`${inputClass} resize-y min-h-[100px]`}
                style={{ fontFamily: 'inherit' }}
              />
            </div>
          ) : (
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
          )}
        </div>
      )}

      {/* Step: When */}
      {step === whenStep && (
        <div>
          <div className="mb-8">
            <div className="flex items-center gap-2 mb-3">
              <SectionLabel className="mb-0">Schedule Type</SectionLabel>
              <HintTip text="Once: runs a single time. Interval: repeats every N minutes. Cron: advanced scheduling with cron syntax" />
            </div>
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
              <div className="flex items-center gap-2 mb-3">
                <SectionLabel className="mb-0">Schedule</SectionLabel>
                <HintTip text="Standard cron format: minute hour day month weekday (e.g. 0 9 * * 1-5 = weekdays at 9am)" />
              </div>

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

      {/* Step: Review */}
      {step === reviewStep && (
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
            {editing && (
              <div>
                <span className="text-[11px] text-text-3/50 uppercase tracking-wider font-600">Created By</span>
                {creatorAgent ? (
                  <div className="mt-1 inline-flex items-center gap-2 rounded-[10px] bg-white/[0.04] px-3 py-2 text-[13px] text-text-2">
                    <AgentAvatar
                      seed={creatorAgent.avatarSeed}
                      avatarUrl={creatorAgent.avatarUrl}
                      name={creatorAgent.name}
                      size={18}
                    />
                    <span>{creatorAgent.name}</span>
                  </div>
                ) : (
                  <div className="text-[13px] text-text-2 mt-0.5">
                    {isUserCreatedSchedule(editing) ? 'Manual / user-created' : 'Unknown'}
                  </div>
                )}
              </div>
            )}
            <div>
              <span className="text-[11px] text-text-3/50 uppercase tracking-wider font-600">Mode</span>
              <div className="text-[14px] text-text font-600 mt-0.5">{taskMode === 'wake_only' ? 'Wake agent only' : 'Create task'}</div>
            </div>
            <div>
              <span className="text-[11px] text-text-3/50 uppercase tracking-wider font-600">{taskMode === 'wake_only' ? 'Wake Message' : 'Task'}</span>
              <div className="text-[13px] text-text-2 mt-0.5 whitespace-pre-wrap">{taskMode === 'wake_only' ? message : taskPrompt}</div>
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
          <button onClick={() => setConfirmDelete(true)} className="py-3.5 px-6 rounded-[14px] border border-red-500/20 bg-transparent text-red-400 text-[15px] font-600 cursor-pointer hover:bg-red-500/10 transition-all" style={{ fontFamily: 'inherit' }}>
            Delete
          </button>
        )}
        {step > (isCreating ? templateStep : 0) && step !== templateStep && (
          <button
            onClick={() => setStep((step - 1) as Step)}
            className="py-3.5 px-6 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[15px] font-600 cursor-pointer hover:bg-surface-2 transition-all"
            style={{ fontFamily: 'inherit' }}
          >
            Back
          </button>
        )}
        <div className="flex-1" />
        {step !== templateStep && (
          <button
            onClick={onClose}
            className="py-3.5 px-6 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[15px] font-600 cursor-pointer hover:bg-surface-2 transition-all"
            style={{ fontFamily: 'inherit' }}
          >
            Cancel
          </button>
        )}
        {step === templateStep && isCreating ? (
          <button
            onClick={onClose}
            className="py-3.5 px-6 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[15px] font-600 cursor-pointer hover:bg-surface-2 transition-all"
            style={{ fontFamily: 'inherit' }}
          >
            Cancel
          </button>
        ) : step < reviewStep ? (
          <button
            onClick={() => setStep((step + 1) as Step)}
            disabled={step === whatStep ? !step0Valid : !step1Valid}
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
      <ConfirmDialog
        open={confirmDelete}
        title="Delete Schedule?"
        message={editing ? `Delete "${editing.name}"? This will remove the schedule from the app.` : 'Delete this schedule?'}
        confirmLabel={deleting ? 'Deleting...' : 'Delete'}
        confirmDisabled={deleting}
        cancelDisabled={deleting}
        danger
        onConfirm={() => { void handleDelete() }}
        onCancel={() => { if (!deleting) setConfirmDelete(false) }}
      />
    </BottomSheet>
  )
}
