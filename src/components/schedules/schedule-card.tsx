'use client'

import type { Schedule } from '@/types'
import { useAppStore } from '@/stores/use-app-store'

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
}

export function ScheduleCard({ schedule }: Props) {
  const setEditingScheduleId = useAppStore((s) => s.setEditingScheduleId)
  const setScheduleSheetOpen = useAppStore((s) => s.setScheduleSheetOpen)
  const agents = useAppStore((s) => s.agents)

  const handleClick = () => {
    setEditingScheduleId(schedule.id)
    setScheduleSheetOpen(true)
  }

  const agent = agents[schedule.agentId]
  const statusClass = STATUS_COLORS[schedule.status] || STATUS_COLORS.paused

  return (
    <div
      onClick={handleClick}
      className="relative py-3.5 px-4 cursor-pointer rounded-[14px]
        transition-all duration-200 active:scale-[0.98]
        bg-transparent border border-transparent hover:bg-white/[0.02] hover:border-white/[0.03]"
    >
      <div className="flex items-center gap-2.5">
        <span className="font-display text-[14px] font-600 truncate flex-1 tracking-[-0.01em]">{schedule.name}</span>
        <span className={`shrink-0 text-[10px] font-600 uppercase tracking-wider px-2 py-0.5 rounded-[6px] ${statusClass}`}>
          {schedule.status}
        </span>
      </div>
      <div className="text-[12px] text-text-3/40 mt-1.5 truncate">
        {agent?.name || 'Unknown agent'} &middot; {schedule.scheduleType}
      </div>
      <div className="text-[11px] text-text-3/30 mt-1">
        Next: {formatNext(schedule.nextRunAt)}
      </div>
    </div>
  )
}
