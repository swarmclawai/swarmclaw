'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { ScheduleCard } from './schedule-card'
import { SCHEDULE_TEMPLATES, FEATURED_TEMPLATE_IDS } from '@/lib/schedules/schedule-templates'
import { Newspaper, HeartPulse, PenLine, FileText } from 'lucide-react'
import { PageLoader } from '@/components/ui/page-loader'
import { SearchInput } from '@/components/ui/search-input'
import { Button } from '@/components/ui/button'

const FEATURED_ICONS: Record<string, React.ComponentType<{ className?: string; size?: number }>> = {
  Newspaper, HeartPulse, PenLine, FileText,
}

const featuredTemplates = SCHEDULE_TEMPLATES.filter((t) =>
  (FEATURED_TEMPLATE_IDS as readonly string[]).includes(t.id),
)

interface Props {
  inSidebar?: boolean
}

export function ScheduleList({ inSidebar }: Props) {
  const schedules = useAppStore((s) => s.schedules)
  const loadSchedules = useAppStore((s) => s.loadSchedules)
  const setScheduleSheetOpen = useAppStore((s) => s.setScheduleSheetOpen)
  const setTemplatePrefill = useAppStore((s) => s.setScheduleTemplatePrefill)
  const activeProjectFilter = useAppStore((s) => s.activeProjectFilter)
  const [search, setSearch] = useState('')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => { loadSchedules().finally(() => setLoaded(true)) }, [])

  const filtered = useMemo(() => {
    return Object.values(schedules)
      .filter((s) => {
        if (search && !s.name.toLowerCase().includes(search.toLowerCase())) return false
        if (activeProjectFilter && s.projectId !== activeProjectFilter) return false
        return true
      })
      .sort((a, b) => b.createdAt - a.createdAt)
  }, [schedules, search, activeProjectFilter])

  if (!loaded) {
    return <PageLoader label="Loading schedules..." />
  }

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
          <>
            <Button
              variant="accent"
              onClick={() => setScheduleSheetOpen(true)}
              className="mt-3 px-8 py-3 rounded-[14px] text-[14px] cursor-pointer active:scale-95 shadow-[0_4px_16px_rgba(99,102,241,0.2)]"
            >
              + New Schedule
            </Button>
            <div className="mt-6 w-full max-w-lg">
              <p className="text-[12px] text-text-3/40 uppercase tracking-wider font-600 mb-3">Quick start</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                {featuredTemplates.map((tpl) => {
                  const IconComp = FEATURED_ICONS[tpl.icon] || FileText
                  return (
                    <button
                      key={tpl.id}
                      onClick={() => {
                        setTemplatePrefill({
                          name: tpl.name,
                          taskPrompt: tpl.defaults.taskPrompt,
                          scheduleType: tpl.defaults.scheduleType,
                          cron: tpl.defaults.cron,
                          intervalMs: tpl.defaults.intervalMs,
                        })
                        setScheduleSheetOpen(true)
                      }}
                      className="flex flex-col items-center gap-2 p-4 rounded-[14px] border border-white/[0.06]
                        bg-surface cursor-pointer transition-all duration-200 hover:bg-surface-2
                        hover:border-white/[0.1] active:scale-[0.97]"
                      style={{ fontFamily: 'inherit' }}
                    >
                      <div className="w-8 h-8 rounded-[8px] bg-accent-soft flex items-center justify-center">
                        <IconComp size={14} className="text-accent-bright" />
                      </div>
                      <span className="text-[12px] font-600 text-text-2">{tpl.name}</span>
                      <span className="text-[11px] text-text-3/50 leading-[1.3]">{tpl.description}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {(filtered.length > 3 || search) && (
        <div className={inSidebar ? 'px-4 py-2.5' : 'px-5 py-2.5'}>
          <SearchInput
            size="sm"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onClear={() => setSearch('')}
            placeholder="Search schedules..."
          />
        </div>
      )}
      <div className={inSidebar
          ? 'flex flex-col gap-1 px-2 pb-4'
          : 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 px-5 pb-6'
        }>
        {filtered.map((s, idx) => (
          <ScheduleCard key={s.id} schedule={s} inSidebar={inSidebar} index={idx} />
        ))}
      </div>
    </div>
  )
}
