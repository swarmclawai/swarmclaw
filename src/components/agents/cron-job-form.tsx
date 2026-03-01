'use client'

import { useState } from 'react'
import type { GatewayCronJob } from '@/types'
import { api } from '@/lib/api-client'

interface Props {
  agentId: string
  onSaved: () => void
  onCancel: () => void
}

export function CronJobForm({ agentId, onSaved, onCancel }: Props) {
  const [name, setName] = useState('')
  const [scheduleKind, setScheduleKind] = useState<'at' | 'every' | 'cron'>('every')
  const [scheduleValue, setScheduleValue] = useState('1h')
  const [timezone, setTimezone] = useState('')
  const [payloadKind, setPayloadKind] = useState<'systemEvent' | 'agentTurn'>('agentTurn')
  const [payloadText, setPayloadText] = useState('')
  const [sessionTarget, setSessionTarget] = useState<'main' | 'isolated'>('main')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const handleSave = async () => {
    if (!name.trim()) return
    setSaving(true)
    setError('')

    const job: Partial<GatewayCronJob> = {
      name: name.trim(),
      agentId,
      enabled: true,
      schedule: { kind: scheduleKind, value: scheduleValue, timezone: timezone || undefined },
      payload: {
        kind: payloadKind,
        ...(payloadKind === 'agentTurn' ? { message: payloadText } : { text: payloadText }),
      },
      sessionTarget,
    }

    try {
      await api('POST', '/openclaw/cron', { action: 'add', job })
      onSaved()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create')
    } finally {
      setSaving(false)
    }
  }

  const inputClass = 'w-full px-3 py-2 rounded-[10px] border border-white/[0.06] bg-black/20 text-[13px] text-text outline-none placeholder:text-text-3/40 focus:border-white/[0.12] transition-colors'

  return (
    <div className="flex flex-col gap-3 p-4 border border-white/[0.06] rounded-[12px] bg-white/[0.02]">
      <div>
        <label className="block text-[11px] font-600 uppercase tracking-wider text-text-3/50 mb-1">Name</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Job name" className={inputClass} />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-[11px] font-600 uppercase tracking-wider text-text-3/50 mb-1">Schedule Type</label>
          <select value={scheduleKind} onChange={(e) => setScheduleKind(e.target.value as typeof scheduleKind)} className={inputClass}>
            <option value="every">Every (interval)</option>
            <option value="at">At (specific time)</option>
            <option value="cron">Cron expression</option>
          </select>
        </div>
        <div>
          <label className="block text-[11px] font-600 uppercase tracking-wider text-text-3/50 mb-1">Value</label>
          <input
            type="text"
            value={scheduleValue}
            onChange={(e) => setScheduleValue(e.target.value)}
            placeholder={scheduleKind === 'cron' ? '0 */6 * * *' : scheduleKind === 'at' ? '09:00' : '1h'}
            className={inputClass}
          />
        </div>
      </div>

      {scheduleKind !== 'every' && (
        <div>
          <label className="block text-[11px] font-600 uppercase tracking-wider text-text-3/50 mb-1">Timezone</label>
          <input type="text" value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="America/New_York" className={inputClass} />
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-[11px] font-600 uppercase tracking-wider text-text-3/50 mb-1">Payload</label>
          <select value={payloadKind} onChange={(e) => setPayloadKind(e.target.value as typeof payloadKind)} className={inputClass}>
            <option value="agentTurn">Agent Turn</option>
            <option value="systemEvent">System Event</option>
          </select>
        </div>
        <div>
          <label className="block text-[11px] font-600 uppercase tracking-wider text-text-3/50 mb-1">Session</label>
          <select value={sessionTarget} onChange={(e) => setSessionTarget(e.target.value as typeof sessionTarget)} className={inputClass}>
            <option value="main">Main session</option>
            <option value="isolated">Isolated session</option>
          </select>
        </div>
      </div>

      <div>
        <label className="block text-[11px] font-600 uppercase tracking-wider text-text-3/50 mb-1">Message / Text</label>
        <textarea
          value={payloadText}
          onChange={(e) => setPayloadText(e.target.value)}
          placeholder="Message to send..."
          rows={2}
          className={`${inputClass} resize-none`}
        />
      </div>

      {error && <p className="text-[12px] text-red-400">{error}</p>}

      <div className="flex gap-2 justify-end">
        <button
          onClick={onCancel}
          className="px-3 py-1.5 rounded-[8px] border border-white/[0.08] bg-transparent text-text-3 text-[12px] font-600 cursor-pointer transition-all hover:bg-white/[0.04]"
          style={{ fontFamily: 'inherit' }}
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving || !name.trim()}
          className="px-4 py-1.5 rounded-[8px] border-none bg-accent-bright text-white text-[12px] font-600 cursor-pointer disabled:opacity-30 transition-all hover:brightness-110"
          style={{ fontFamily: 'inherit' }}
        >
          {saving ? 'Creating...' : 'Create'}
        </button>
      </div>
    </div>
  )
}
