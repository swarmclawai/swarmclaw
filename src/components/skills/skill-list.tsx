'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAppStore } from '@/stores/use-app-store'
import { useWs } from '@/hooks/use-ws'
import type { Skill } from '@/types'
import { SkillsWorkspace } from './skills-workspace'

export function SkillList({ inSidebar }: { inSidebar?: boolean }) {
  if (!inSidebar) return <SkillsWorkspace />
  return <SidebarSkillList />
}

function SidebarSkillList() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const skills = useAppStore((s) => s.skills)
  const loadSkills = useAppStore((s) => s.loadSkills)
  const activeProjectFilter = useAppStore((s) => s.activeProjectFilter)
  const setEditingSkillId = useAppStore((s) => s.setEditingSkillId)
  const setSkillSheetOpen = useAppStore((s) => s.setSkillSheetOpen)

  const [query, setQuery] = useState('')
  const [ready, setReady] = useState(false)

  const activeTab = searchParams.get('tab') === 'clawhub' ? 'clawhub' : 'skills'
  const selectedSkillId = activeTab === 'skills' ? searchParams.get('skill') : null

  useEffect(() => {
    let active = true
    void loadSkills().finally(() => {
      if (active) setReady(true)
    })
    return () => {
      active = false
    }
  }, [loadSkills])

  useWs('skills', () => { void loadSkills() })

  const setPageState = useCallback((patch: Record<string, string | null | undefined>) => {
    const next = new URLSearchParams(searchParams.toString())
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === undefined || value === '') {
        next.delete(key)
      } else {
        next.set(key, value)
      }
    }
    router.push(next.toString() ? `/skills?${next.toString()}` : '/skills')
  }, [router, searchParams])

  const skillList = useMemo(() => {
    const scoped = Object.values(skills).filter((skill) => !activeProjectFilter || skill.projectId === activeProjectFilter)
    const filtered = query.trim()
      ? scoped.filter((skill) => buildSkillSearchText(skill).includes(query.trim().toLowerCase()))
      : scoped

    return filtered.sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))
  }, [activeProjectFilter, query, skills])

  return (
    <div className="flex flex-1 flex-col overflow-hidden px-3 pb-4">
      <div className="rounded-[14px] border border-white/[0.08] bg-surface/75 p-3">
        <label className="relative block">
          <svg className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-3/45" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter local skills..."
            className="w-full rounded-[12px] border border-white/[0.08] bg-bg/65 py-2.5 pl-9 pr-3 text-[12px] text-text outline-none transition-colors placeholder:text-text-3/45 focus:border-accent-bright/35"
            style={{ fontFamily: 'inherit' }}
          />
        </label>

        <div className="mt-3 flex items-center justify-between gap-2">
          <div className="text-[11px] text-text-3/65">
            {skillList.length} skill{skillList.length === 1 ? '' : 's'}
          </div>
          <button
            type="button"
            onClick={() => setPageState({ tab: 'clawhub', skill: null })}
            className="cursor-pointer rounded-full border border-accent-bright/18 bg-accent-soft px-3 py-1 text-[11px] font-700 text-accent-bright transition-colors hover:bg-accent-soft/80"
          >
            Browse ClawHub
          </button>
        </div>
      </div>

      <div className="mt-3 flex-1 overflow-y-auto">
        {!ready ? (
          <div className="flex items-center justify-center py-10 text-[12px] text-text-3/65">
            <span className="mr-3 h-4 w-4 animate-spin rounded-full border-2 border-white/[0.12] border-t-accent-bright" />
            Loading skills...
          </div>
        ) : skillList.length === 0 ? (
          <div className="rounded-[16px] border border-dashed border-white/[0.08] px-4 py-8 text-center">
            <div className="text-[13px] font-600 text-text">{query.trim() ? 'No matching skills' : 'No local skills yet'}</div>
            <p className="mt-1 text-[11px] leading-[1.6] text-text-3/65">
              {query.trim()
                ? 'Try a broader search or browse ClawHub for something new.'
                : 'Create a skill or import one from the marketplace.'}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {skillList.map((skill) => {
              const selected = selectedSkillId === skill.id
              return (
                <div
                  key={skill.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setPageState({ tab: 'skills', skill: skill.id })}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      setPageState({ tab: 'skills', skill: skill.id })
                    }
                  }}
                  className={`rounded-[14px] border px-3 py-3 text-left transition-all ${
                    selected
                      ? 'cursor-pointer border-accent-bright/20 bg-accent-soft/60'
                      : 'cursor-pointer border-white/[0.06] bg-surface hover:border-white/[0.12] hover:bg-surface-2'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className={`truncate text-[13px] font-700 ${selected ? 'text-accent-bright' : 'text-text'}`}>
                        {skill.name}
                      </div>
                      <div className="mt-1 line-clamp-2 text-[11px] leading-[1.6] text-text-3/65">
                        {skill.description || plainTextExcerpt(skill.content, 96)}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className={`inline-flex h-7 w-7 items-center justify-center rounded-full border text-text-3/60 transition-colors ${
                        selected ? 'border-accent-bright/20 text-accent-bright' : 'border-white/[0.08]'
                      }`}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M5 12h14" />
                          <path d="m12 5 7 7-7 7" />
                        </svg>
                      </span>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          setEditingSkillId(skill.id)
                          setSkillSheetOpen(true)
                        }}
                        className="cursor-pointer rounded-full border border-white/[0.08] px-2 py-1 text-[10px] font-700 text-text-3/70 transition-colors hover:border-white/[0.14] hover:text-text"
                      >
                        Edit
                      </button>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {skill.version ? <SidebarBadge>v{skill.version}</SidebarBadge> : null}
                    <SidebarBadge>{(skill.scope || 'global') === 'agent' ? 'Agent' : 'Global'}</SidebarBadge>
                    {skill.security ? (
                      <SidebarBadge tone={skill.security.level === 'high' ? 'danger' : skill.security.level === 'medium' ? 'warning' : 'neutral'}>
                        {skill.security.level}
                      </SidebarBadge>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function SidebarBadge({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode
  tone?: 'neutral' | 'warning' | 'danger'
}) {
  const className = tone === 'warning'
    ? 'border-amber-500/18 bg-amber-500/10 text-amber-300'
    : tone === 'danger'
      ? 'border-red-500/18 bg-red-500/10 text-red-300'
      : 'border-white/[0.08] bg-white/[0.04] text-text-3/70'

  return (
    <span className={`rounded-full border px-2 py-1 text-[10px] font-700 uppercase tracking-[0.08em] ${className}`}>
      {children}
    </span>
  )
}

function buildSkillSearchText(skill: Skill) {
  return [
    skill.name,
    skill.filename,
    skill.description || '',
    skill.content,
    ...(skill.tags || []),
    ...(skill.toolNames || []),
    ...(skill.capabilities || []),
  ].join(' ').toLowerCase()
}

function plainTextExcerpt(markdown: string, maxLength: number) {
  const text = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/^#+\s+/gm, '')
    .replace(/[>*_~|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength).trimEnd()}...`
}
