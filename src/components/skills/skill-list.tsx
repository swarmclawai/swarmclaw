'use client'

import { useEffect, useState, useCallback } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { api } from '@/lib/api-client'
import { Badge } from '@/components/ui/badge'
import { ClawHubBrowser } from './clawhub-browser'
import { toast } from 'sonner'

interface ClawHubSkill {
  id: string
  name: string
  description: string
  author: string
  tags: string[]
  downloads: number
  url: string
  version: string
}

interface SearchResponse {
  skills: ClawHubSkill[]
  total: number
  page: number
}

export function SkillList({ inSidebar }: { inSidebar?: boolean }) {
  const skills = useAppStore((s) => s.skills)
  const loadSkills = useAppStore((s) => s.loadSkills)
  const setSkillSheetOpen = useAppStore((s) => s.setSkillSheetOpen)
  const setEditingSkillId = useAppStore((s) => s.setEditingSkillId)
  const activeProjectFilter = useAppStore((s) => s.activeProjectFilter)
  const [clawHubOpen, setClawHubOpen] = useState(false)

  // Embedded ClawHub state (full-width only)
  const [tab, setTab] = useState<'skills' | 'clawhub'>('skills')
  const [hubQuery, setHubQuery] = useState('')
  const [hubSkills, setHubSkills] = useState<ClawHubSkill[]>([])
  const [hubPage, setHubPage] = useState(1)
  const [hubTotal, setHubTotal] = useState(0)
  const [hubLoading, setHubLoading] = useState(false)
  const [hubSearched, setHubSearched] = useState(false)
  const [hubError, setHubError] = useState<string | null>(null)
  const [installing, setInstalling] = useState<string | null>(null)

  useEffect(() => {
    loadSkills()
  }, [])

  const skillList = Object.values(skills).filter((s) => !activeProjectFilter || s.projectId === activeProjectFilter)

  const handleEdit = (id: string) => {
    setEditingSkillId(id)
    setSkillSheetOpen(true)
  }

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    await api('DELETE', `/skills/${id}`)
    loadSkills()
  }

  // Embedded ClawHub search
  const searchHub = useCallback(async (q: string, p: number, append = false) => {
    setHubLoading(true)
    setHubError(null)
    try {
      const res = await api<SearchResponse>('GET', `/clawhub/search?q=${encodeURIComponent(q)}&page=${p}`)
      if (append) {
        setHubSkills(prev => [...prev, ...res.skills])
      } else {
        setHubSkills(res.skills)
      }
      setHubTotal(res.total)
      setHubPage(res.page)
      setHubSearched(true)
    } catch (err) {
      setHubError(err instanceof Error ? err.message : 'Failed to search ClawHub')
    } finally {
      setHubLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!inSidebar && tab === 'clawhub' && !hubSearched) {
      searchHub('', 1)
    }
  }, [tab, inSidebar, hubSearched, searchHub])

  const handleHubSearch = () => {
    setHubSkills([])
    searchHub(hubQuery, 1)
  }

  const handleInstall = async (skill: ClawHubSkill) => {
    setInstalling(skill.id)
    try {
      await api('POST', '/clawhub/install', {
        name: skill.name,
        description: skill.description,
        url: skill.url,
        tags: skill.tags,
      })
      toast.success(`Installed "${skill.name}"`)
      loadSkills()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Install failed')
    } finally {
      setInstalling(null)
    }
  }

  const tabClass = (t: string) =>
    `py-1.5 px-3.5 rounded-[8px] text-[12px] font-600 cursor-pointer transition-all border
    ${tab === t
      ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
      : 'bg-transparent border-transparent text-text-3 hover:text-text-2'}`

  const renderClawHub = () => {
    const hasMore = hubSkills.length < hubTotal

    return (
      <div className="space-y-3">
        <div className="flex gap-2">
          <input
            placeholder="Search skills..."
            value={hubQuery}
            onChange={(e) => setHubQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleHubSearch()}
            className="flex-1 px-3 py-2.5 rounded-[10px] bg-surface border border-white/[0.06] text-[12px] text-text placeholder:text-text-3/50 outline-none focus:border-accent-bright/30"
            style={{ fontFamily: 'inherit' }}
          />
          <button
            onClick={handleHubSearch}
            disabled={hubLoading}
            className="px-3.5 py-2 rounded-[10px] text-[12px] font-600 bg-accent-soft text-accent-bright border border-accent-bright/20 hover:bg-accent-soft/80 transition-all cursor-pointer disabled:opacity-50"
            style={{ fontFamily: 'inherit' }}
          >
            Search
          </button>
        </div>

        {hubError && (
          <div className="text-center py-8">
            <p className="text-[13px] text-red-400">{hubError}</p>
            <button onClick={() => searchHub(hubQuery, 1)} className="mt-2 text-[12px] text-text-3/60 hover:text-text-3 cursor-pointer bg-transparent border-none" style={{ fontFamily: 'inherit' }}>
              Retry
            </button>
          </div>
        )}

        {!hubError && !hubLoading && hubSearched && hubSkills.length === 0 && (
          <div className="text-center py-8">
            <p className="text-[13px] text-text-3/60">No skills found</p>
            {hubQuery && <p className="text-[11px] text-text-3/40 mt-1">Try a different search term</p>}
          </div>
        )}

        {hubSkills.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {hubSkills.map((skill) => (
              <div
                key={skill.id}
                className="p-4 rounded-[14px] border border-white/[0.06] bg-surface"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="font-display text-[14px] font-600 text-text truncate">{skill.name}</span>
                      <span className="text-[10px] font-mono text-text-3/40 shrink-0">v{skill.version}</span>
                    </div>
                    <p className="text-[12px] text-text-3/60 line-clamp-2 mb-2">{skill.description}</p>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {skill.tags.slice(0, 4).map((tag) => (
                        <Badge key={tag} variant="secondary" className="text-[10px] px-1.5 py-0">{tag}</Badge>
                      ))}
                    </div>
                    <div className="flex items-center gap-3 mt-2 text-[11px] text-text-3/50">
                      <span>{skill.author}</span>
                      <span>{skill.downloads.toLocaleString()} installs</span>
                    </div>
                  </div>
                  <button
                    onClick={() => handleInstall(skill)}
                    disabled={installing === skill.id}
                    className="shrink-0 py-2 px-3.5 rounded-[10px] text-[12px] font-600 bg-accent-soft text-accent-bright border border-accent-bright/20 hover:bg-accent-soft/80 transition-all cursor-pointer disabled:opacity-50"
                    style={{ fontFamily: 'inherit' }}
                  >
                    {installing === skill.id ? 'Installing...' : 'Install'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {hasMore && (
          <div className="pt-2 pb-4 text-center">
            <button
              onClick={() => searchHub(hubQuery, hubPage + 1, true)}
              disabled={hubLoading}
              className="text-[12px] text-text-3/60 hover:text-text-3 cursor-pointer bg-transparent border-none"
              style={{ fontFamily: 'inherit' }}
            >
              {hubLoading ? 'Loading...' : 'Load More'}
            </button>
          </div>
        )}

        {hubLoading && hubSkills.length === 0 && (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-text-3/20 border-t-text-3/60" />
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={`flex-1 overflow-y-auto ${inSidebar ? 'px-3 pb-4' : 'px-5 pb-6'}`}>
      {/* Sidebar: ClawHub button + Sheet */}
      {inSidebar && (
        <>
          <button
            onClick={() => setClawHubOpen(true)}
            className="w-full mb-3 py-2.5 px-4 rounded-[12px] border border-dashed border-white/[0.1] text-[13px] font-600 text-text-3 hover:text-accent-bright hover:border-accent-bright/30 transition-all cursor-pointer bg-transparent"
            style={{ fontFamily: 'inherit' }}
          >
            Browse ClawHub Skills
          </button>
          <ClawHubBrowser open={clawHubOpen} onOpenChange={setClawHubOpen} onInstalled={() => loadSkills()} />
        </>
      )}

      {/* Full-width: tabs */}
      {!inSidebar && (
        <div className="flex gap-1 mb-4">
          <button onClick={() => setTab('skills')} className={tabClass('skills')} style={{ fontFamily: 'inherit' }}>
            My Skills
          </button>
          <button onClick={() => setTab('clawhub')} className={tabClass('clawhub')} style={{ fontFamily: 'inherit' }}>
            ClawHub
          </button>
        </div>
      )}

      {(!inSidebar && tab === 'clawhub') ? renderClawHub() : (
        skillList.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-[13px] text-text-3/60">No skills yet</p>
            <button
              onClick={() => setSkillSheetOpen(true)}
              className="mt-3 px-4 py-2 rounded-[10px] bg-transparent text-accent-bright text-[13px] font-600 cursor-pointer border border-accent-bright/20 hover:bg-accent-soft transition-all"
              style={{ fontFamily: 'inherit' }}
            >
              + Add Skill
            </button>
          </div>
        ) : (
          <div className={inSidebar ? 'space-y-2' : 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3'}>
            {skillList.map((skill) => (
              <button
                key={skill.id}
                onClick={() => handleEdit(skill.id)}
                className="w-full text-left p-4 rounded-[14px] border border-white/[0.06] bg-surface hover:bg-surface-2 transition-all cursor-pointer"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-display text-[14px] font-600 text-text truncate">{skill.name}</span>
                  <div className="flex items-center gap-2 shrink-0 ml-2">
                    <span className="text-[10px] font-mono text-text-3/50">{skill.filename}</span>
                    {!inSidebar && (
                      <button
                        onClick={(e) => handleDelete(e, skill.id)}
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
                {skill.description && (
                  <p className="text-[12px] text-text-3/60 line-clamp-2">{skill.description}</p>
                )}
                <div className="text-[11px] text-text-3/70 mt-1.5">
                  {skill.content.length} chars
                </div>
              </button>
            ))}
          </div>
        )
      )}
    </div>
  )
}
