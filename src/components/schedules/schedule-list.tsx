'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { ScheduleCard } from './schedule-card'

interface Props {
  inSidebar?: boolean
}

export function ScheduleList({ inSidebar }: Props) {
  const schedules = useAppStore((s) => s.schedules)
  const loadSchedules = useAppStore((s) => s.loadSchedules)
  const setScheduleSheetOpen = useAppStore((s) => s.setScheduleSheetOpen)
  const [search, setSearch] = useState('')

  useEffect(() => { loadSchedules() }, [])

  const filtered = useMemo(() => {
    return Object.values(schedules)
      .filter((s) => {
        if (search && !s.name.toLowerCase().includes(search.toLowerCase())) return false
        return true
      })
      .sort((a, b) => b.createdAt - a.createdAt)
  }, [schedules, search])

  if (!filtered.length && !search) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 text-text-3 p-8 text-center">
        <div className="w-12 h-12 rounded-[14px] bg-accent-soft flex items-center justify-center mb-1">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-accent-bright">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
        </div>
        <p className="font-display text-[15px] font-600 text-text-2">No schedules yet</p>
        <p className="text-[13px] text-text-3/50">Automate tasks with cron or intervals</p>
        {!inSidebar && (
          <button
            onClick={() => setScheduleSheetOpen(true)}
            className="mt-3 px-8 py-3 rounded-[14px] border-none bg-[#6366F1] text-white
              text-[14px] font-600 cursor-pointer active:scale-95 transition-all duration-200
              shadow-[0_4px_16px_rgba(99,102,241,0.2)]"
            style={{ fontFamily: 'inherit' }}
          >
            + New Schedule
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {(filtered.length > 3 || search) && (
        <div className="px-4 py-2.5">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search schedules..."
            className="w-full px-4 py-2.5 rounded-[12px] border border-white/[0.04] bg-surface text-text
              text-[13px] outline-none transition-all duration-200 placeholder:text-text-3/40 focus-glow"
            style={{ fontFamily: 'inherit' }}
          />
        </div>
      )}
      <div className="flex flex-col gap-1 px-2 pb-4">
        {filtered.map((s) => (
          <ScheduleCard key={s.id} schedule={s} />
        ))}
      </div>
    </div>
  )
}
