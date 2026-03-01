'use client'

import type { Schedule } from '@/types'
import { useAppStore } from '@/stores/use-app-store'
import { api } from '@/lib/api-client'

const STATUS_COLORS: Record<string, string> = {
  active: 'text-emerald-400 bg-emerald-400/[0.08]',
  paused: 'text-amber-400 bg-amber-400/[0.08]',
  completed: 'text-text-3 bg-white/[0.03]',
  failed: 'text-red-400 bg-red-400/[0.08]',
}

function formatNext(ts?: number): string {
  if (!ts) return 'Not scheduled'
  const d = new Date(ts)
  const now = Date.now()
  const diff = ts - now
  if (diff < 0) return 'Overdue'
  if (diff < 60000) return 'In < 1m'
  if (diff < 3600000) return `In ${Math.floor(diff / 60000)}m`
  if (diff < 86400000) return `In ${Math.floor(diff / 3600000)}h`
  return d.toLocaleDateString()
}

interface Props {
  schedule: Schedule
  inSidebar?: boolean
}

export function ScheduleCard({ schedule, inSidebar }: Props) {
  const setEditingScheduleId = useAppStore((s) => s.setEditingScheduleId)
  const setScheduleSheetOpen = useAppStore((s) => s.setScheduleSheetOpen)
  const loadSchedules = useAppStore((s) => s.loadSchedules)
  const agents = useAppStore((s) => s.agents)

  const handleClick = () => {
    setEditingScheduleId(schedule.id)
    setScheduleSheetOpen(true)
  }

  const handleToggle = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const newStatus = schedule.status === 'active' ? 'paused' : 'active'
    await api('PUT', `/schedules/${schedule.id}`, { status: newStatus })
    loadSchedules()
  }

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation()
    await api('DELETE', `/schedules/${schedule.id}`)
    loadSchedules()
  }

  const agent = agents[schedule.agentId]
  const statusClass = STATUS_COLORS[schedule.status] || STATUS_COLORS.paused
  const canToggle = schedule.status === 'active' || schedule.status === 'paused'

  return (
    <div
      onClick={handleClick}
      className="relative py-3.5 px-4 cursor-pointer rounded-[14px]
        transition-all duration-200 active:scale-[0.98]
        bg-transparent border border-transparent hover:bg-white/[0.02] hover:border-white/[0.03]"
    >
      <div className="flex items-center gap-2.5">
        <span className="font-display text-[14px] font-600 truncate flex-1 tracking-[-0.01em]">{schedule.name}</span>
        <div className="flex items-center gap-2 shrink-0">
          {!inSidebar && canToggle && (
            <div
              onClick={handleToggle}
              className={`w-9 h-5 rounded-full transition-all relative cursor-pointer shrink-0
                ${schedule.status === 'active' ? 'bg-[#6366F1]' : 'bg-white/[0.08]'}`}
            >
              <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all
                ${schedule.status === 'active' ? 'left-[18px]' : 'left-0.5'}`} />
            </div>
          )}
          <span className={`text-[10px] font-600 uppercase tracking-wider px-2 py-0.5 rounded-[6px] ${statusClass}`}>
            {schedule.status}
          </span>
          {!inSidebar && (
            <button
              onClick={handleDelete}
              className="text-text-3/40 hover:text-red-400 transition-colors p-0.5"
              title="Delete"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          )}
        </div>
      </div>
      <div className="text-[12px] text-text-3/70 mt-1.5 truncate">
        {agent?.name || 'Unknown agent'} &middot; {schedule.scheduleType}
        {!inSidebar && schedule.scheduleType === 'cron' && schedule.cron && (
          <span className="font-mono text-text-3/50 ml-1">({schedule.cron})</span>
        )}
        {!inSidebar && schedule.scheduleType === 'interval' && schedule.intervalMs && (
          <span className="text-text-3/50 ml-1">
            (every {schedule.intervalMs >= 3600000
              ? `${Math.round(schedule.intervalMs / 3600000)}h`
              : `${Math.round(schedule.intervalMs / 60000)}m`})
          </span>
        )}
      </div>
      <div className="text-[11px] text-text-3/60 mt-1">
        Next: {formatNext(schedule.nextRunAt)}
      </div>
    </div>
  )
}
