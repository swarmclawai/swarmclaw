'use client'

import { useEffect, useState, useMemo } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { createSchedule, updateSchedule, deleteSchedule } from '@/lib/schedules'
import { api } from '@/lib/api-client'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import { AiGenBlock } from '@/components/shared/ai-gen-block'
import type { ScheduleType, ScheduleStatus } from '@/types'
import cronstrue from 'cronstrue'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const CRON_PRESETS = [
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Daily at 9am', cron: '0 9 * * *' },
  { label: 'Weekly Mon 9am', cron: '0 9 * * 1' },
]

function getNextRuns(cron: string, count: number = 3): Date[] {
  try {
    // Simple cron parser for next N runs
    const { parseExpression } = require('cron-parser')
    const interval = parseExpression(cron)
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

export function ScheduleSheet() {
  const open = useAppStore((s) => s.scheduleSheetOpen)
  const setOpen = useAppStore((s) => s.setScheduleSheetOpen)
  const editingId = useAppStore((s) => s.editingScheduleId)
  const setEditingId = useAppStore((s) => s.setEditingScheduleId)
  const schedules = useAppStore((s) => s.schedules)
  const loadSchedules = useAppStore((s) => s.loadSchedules)
  const agents = useAppStore((s) => s.agents)
  const loadAgents = useAppStore((s) => s.loadAgents)

  const [name, setName] = useState('')
  const [agentId, setAgentId] = useState('')
  const [taskPrompt, setTaskPrompt] = useState('')
  const [scheduleType, setScheduleType] = useState<ScheduleType>('cron')
  const [cron, setCron] = useState('0 * * * *')
  const [intervalMs, setIntervalMs] = useState(3600000)
  const [status, setStatus] = useState<ScheduleStatus>('active')
  const [customCron, setCustomCron] = useState(false)

  // AI generation state
  const [aiPrompt, setAiPrompt] = useState('')
  const [generating, setGenerating] = useState(false)
  const [generated, setGenerated] = useState(false)
  const [genError, setGenError] = useState('')
  const appSettings = useAppStore((s) => s.appSettings)
  const loadSettings = useAppStore((s) => s.loadSettings)

  const editing = editingId ? schedules[editingId] : null
  const agentList = Object.values(agents)

  const handleGenerate = async () => {
    if (!aiPrompt.trim()) return
    setGenerating(true)
    setGenError('')
    try {
      const result = await api<{ name?: string; taskPrompt?: string; scheduleType?: ScheduleType; cron?: string; intervalMs?: number; error?: string }>('POST', '/generate', { type: 'schedule', prompt: aiPrompt })
      if (result.error) {
        setGenError(result.error)
      } else if (result.name || result.taskPrompt) {
        if (result.name) setName(result.name)
        if (result.taskPrompt) setTaskPrompt(result.taskPrompt)
        if (result.scheduleType) setScheduleType(result.scheduleType)
        if (result.cron) { setCron(result.cron); setCustomCron(true) }
        if (result.intervalMs) setIntervalMs(result.intervalMs)
        setGenerated(true)
      } else {
        setGenError('AI returned empty response — try again')
      }
    } catch (err: unknown) {
      setGenError(err instanceof Error ? err.message : 'Generation failed')
    }
    setGenerating(false)
  }

  useEffect(() => {
    if (open) {
      loadAgents()
      loadSettings()
      setAiPrompt('')
      setGenerating(false)
      setGenerated(false)
      setGenError('')
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
  }, [open, editingId])

  const cronHuman = useMemo(() => formatCronHuman(cron), [cron])
  const nextRuns = useMemo(() => getNextRuns(cron), [cron])

  const onClose = () => {
    setOpen(false)
    setEditingId(null)
  }

  const handleSave = async () => {
    const data = {
      name: name.trim() || 'Unnamed Schedule',
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

  const inputClass = "w-full px-4 py-3.5 rounded-[14px] border border-white/[0.08] bg-surface text-text text-[15px] outline-none transition-all duration-200 placeholder:text-text-3/50 focus-glow"

  return (
    <BottomSheet open={open} onClose={onClose} wide>
      <div className="mb-10">
        <h2 className="font-display text-[28px] font-700 tracking-[-0.03em] mb-2">
          {editing ? 'Edit Schedule' : 'New Schedule'}
        </h2>
        <p className="text-[14px] text-text-3">Automate agent tasks on a schedule</p>
      </div>

      {/* AI Generation */}
      {!editing && <AiGenBlock
        aiPrompt={aiPrompt} setAiPrompt={setAiPrompt}
        generating={generating} generated={generated} genError={genError}
        onGenerate={handleGenerate} appSettings={appSettings}
        placeholder='Describe the schedule, e.g. "Run keyword research every Monday at 9am"'
      />}

      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Name</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Daily keyword research" className={inputClass} style={{ fontFamily: 'inherit' }} />
      </div>

      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Agent</label>
        <Select
          value={agentId || "__none__"}
          onValueChange={(val) => setAgentId(val === "__none__" ? "" : val)}
        >
          <SelectTrigger className={inputClass}>
            <SelectValue placeholder="Select agent..." />
          </SelectTrigger>
          <SelectContent className="bg-surface border-white/[0.08]">
            <SelectItem value="__none__">Select agent...</SelectItem>
            {agentList.map((p) => (
              <SelectItem key={p.id} value={p.id}>{p.name}{p.isOrchestrator ? ' (Orchestrator)' : ''}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Task Prompt</label>
        <textarea
          value={taskPrompt}
          onChange={(e) => setTaskPrompt(e.target.value)}
          placeholder="What should the agent do when triggered?"
          rows={4}
          className={`${inputClass} resize-y min-h-[100px]`}
          style={{ fontFamily: 'inherit' }}
        />
      </div>

      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Schedule Type</label>
        <div className="grid grid-cols-3 gap-3">
          {(['cron', 'interval', 'once'] as ScheduleType[]).map((t) => (
            <button
              key={t}
              onClick={() => setScheduleType(t)}
              className={`py-3.5 px-4 rounded-[14px] text-center cursor-pointer transition-all duration-200
                active:scale-[0.97] text-[14px] font-600 capitalize border
                ${scheduleType === t
                  ? 'bg-primary border-primary text-primary-foreground'
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
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Schedule</label>

          {/* Preset buttons */}
          <div className="flex flex-wrap gap-2 mb-4">
            {CRON_PRESETS.map((p) => (
              <button
                key={p.cron}
                onClick={() => { setCron(p.cron); setCustomCron(false) }}
                className={`px-3.5 py-2 rounded-[10px] text-[13px] font-600 cursor-pointer transition-all border
                  ${cron === p.cron && !customCron
                    ? 'bg-primary border-primary text-primary-foreground'
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
                  ? 'bg-primary border-primary text-primary-foreground'
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
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Interval (minutes)</label>
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
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Status</label>
          <div className="flex gap-2">
            {(['active', 'paused'] as ScheduleStatus[]).map((s) => (
              <button
                key={s}
                onClick={() => setStatus(s)}
                className={`px-4 py-2 rounded-[10px] text-[13px] font-600 capitalize cursor-pointer transition-all border
                  ${status === s
                    ? 'bg-primary border-primary text-primary-foreground'
                    : 'bg-surface border-white/[0.06] text-text-3'}`}
                style={{ fontFamily: 'inherit' }}
              >
                {s}
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
        <button onClick={handleSave} disabled={!name.trim() || !agentId} className="flex-1 py-3.5 rounded-[14px] border-none bg-primary text-primary-foreground text-[15px] font-600 cursor-pointer active:scale-[0.97] disabled:opacity-30 transition-all shadow-[0_4px_20px_rgba(var(--primary-rgb),0.25)] hover:brightness-110" style={{ fontFamily: 'inherit' }}>
          {editing ? 'Save' : 'Create'}
        </button>
      </div>
    </BottomSheet>
  )
}
