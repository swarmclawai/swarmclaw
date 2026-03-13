'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { api } from '@/lib/app/api-client'
import { Badge } from '@/components/ui/badge'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { ClawHubBrowser } from './clawhub-browser'
import { toast } from 'sonner'
import { useMountedRef } from '@/hooks/use-mounted-ref'
import { useWs } from '@/hooks/use-ws'
import type { SkillSuggestion } from '@/types'

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
  const mountedRef = useMountedRef()
  const skills = useAppStore((s) => s.skills)
  const loadSkills = useAppStore((s) => s.loadSkills)
  const agents = useAppStore((s) => s.agents)
  const loadAgents = useAppStore((s) => s.loadAgents)
  const currentAgentId = useAppStore((s) => s.currentAgentId)
  const setSkillSheetOpen = useAppStore((s) => s.setSkillSheetOpen)
  const setEditingSkillId = useAppStore((s) => s.setEditingSkillId)
  const activeProjectFilter = useAppStore((s) => s.activeProjectFilter)
  const [clawHubOpen, setClawHubOpen] = useState(false)
  const currentSessionId = currentAgentId ? agents[currentAgentId]?.threadSessionId || null : null

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
  const [suggestions, setSuggestions] = useState<SkillSuggestion[]>([])
  const [suggestionsLoading, setSuggestionsLoading] = useState(false)
  const [suggestionActionId, setSuggestionActionId] = useState<string | null>(null)
  const [generatingSuggestion, setGeneratingSuggestion] = useState(false)
  const hubSearchRequestIdRef = useRef(0)

  useEffect(() => {
    loadSkills()
    loadAgents()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const skillList = Object.values(skills).filter((s) => !activeProjectFilter || s.projectId === activeProjectFilter)

  const loadSuggestions = useCallback(async () => {
    if (inSidebar) return
    setSuggestionsLoading(true)
    try {
      const result = await api<SkillSuggestion[]>('GET', '/skill-suggestions')
      if (!mountedRef.current) return
      setSuggestions(Array.isArray(result) ? result : [])
    } catch (err) {
      if (!mountedRef.current) return
      toast.error(err instanceof Error ? err.message : 'Failed to load skill suggestions')
    } finally {
      if (mountedRef.current) setSuggestionsLoading(false)
    }
  }, [inSidebar, mountedRef])

  useEffect(() => {
    void loadSuggestions()
  }, [loadSuggestions])
  useWs('skill_suggestions', () => { void loadSuggestions() })

  const handleEdit = (id: string) => {
    setEditingSkillId(id)
    setSkillSheetOpen(true)
  }

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    await api('DELETE', `/skills/${id}`)
    loadSkills()
  }

  const handleGenerateSuggestion = async () => {
    if (!currentSessionId) {
      toast.error('Open a chat first so SwarmClaw has a session to learn from.')
      return
    }
    setGeneratingSuggestion(true)
    try {
      await api<SkillSuggestion>('POST', '/skill-suggestions', { sessionId: currentSessionId })
      toast.success('Drafted a skill suggestion from the current conversation.')
      await loadSuggestions()
      setTab('skills')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to generate a skill suggestion')
    } finally {
      if (mountedRef.current) setGeneratingSuggestion(false)
    }
  }

  const handleApproveSuggestion = async (id: string) => {
    setSuggestionActionId(id)
    try {
      await api('POST', `/skill-suggestions/${id}/approve`)
      toast.success('Skill suggestion approved and saved.')
      await Promise.all([loadSuggestions(), loadSkills()])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to approve the skill suggestion')
    } finally {
      if (mountedRef.current) setSuggestionActionId(null)
    }
  }

  const handleRejectSuggestion = async (id: string) => {
    setSuggestionActionId(id)
    try {
      await api('POST', `/skill-suggestions/${id}/reject`)
      toast.success('Skill suggestion dismissed.')
      await loadSuggestions()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to dismiss the skill suggestion')
    } finally {
      if (mountedRef.current) setSuggestionActionId(null)
    }
  }

  // Embedded ClawHub search
  const searchHub = useCallback(async (q: string, p: number, append = false) => {
    const requestId = hubSearchRequestIdRef.current + 1
    hubSearchRequestIdRef.current = requestId
    setHubLoading(true)
    setHubError(null)
    try {
      const res = await api<SearchResponse>('GET', `/clawhub/search?q=${encodeURIComponent(q)}&page=${p}`)
      if (!mountedRef.current || hubSearchRequestIdRef.current !== requestId) return
      if (append) {
        setHubSkills(prev => [...prev, ...res.skills])
      } else {
        setHubSkills(res.skills)
      }
      setHubTotal(res.total)
      setHubPage(res.page)
      setHubSearched(true)
    } catch (err) {
      if (!mountedRef.current || hubSearchRequestIdRef.current !== requestId) return
      setHubError(err instanceof Error ? err.message : 'Failed to search ClawHub')
    } finally {
      if (mountedRef.current && hubSearchRequestIdRef.current === requestId) {
        setHubLoading(false)
      }
    }
  }, [mountedRef])

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
      if (mountedRef.current) {
        setInstalling(null)
      }
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
            {hubSkills.map((skill, idx) => (
              <div
                key={skill.id}
                className="p-4 rounded-[14px] border border-white/[0.06] bg-surface hover:border-white/[0.12] transition-all hover:scale-[1.01]"
                style={{
                  animation: 'spring-in 0.5s var(--ease-spring) both',
                  animationDelay: `${idx * 0.03}s`
                }}
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

  const renderSuggestions = () => {
    if (inSidebar || tab !== 'skills') return null
    return (
      <div className="mb-5 rounded-[16px] border border-white/[0.06] bg-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
          <div>
            <h3 className="font-display text-[13px] font-600 text-text">Suggested From Conversations</h3>
            <p className="text-[12px] text-text-3/65 mt-1">
              Turn useful work into a reviewable skill draft. New agents keep auto-drafting on by default, and you can still draft from the current chat manually at any time.
            </p>
          </div>
          <button
            onClick={handleGenerateSuggestion}
            disabled={generatingSuggestion}
            className="px-3.5 py-2 rounded-[10px] text-[12px] font-600 bg-accent-soft text-accent-bright border border-accent-bright/20 hover:bg-accent-soft/80 transition-all cursor-pointer disabled:opacity-50"
            style={{ fontFamily: 'inherit' }}
          >
            {generatingSuggestion ? 'Drafting…' : 'Draft From Current Chat'}
          </button>
        </div>

        {suggestionsLoading ? (
          <div className="flex items-center justify-center py-6">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-text-3/20 border-t-text-3/60" />
          </div>
        ) : suggestions.length === 0 ? (
          <div className="rounded-[12px] border border-dashed border-white/[0.08] px-4 py-5 text-[12px] text-text-3/60">
            No drafted suggestions yet. Use the current chat button after a conversation that produced a reusable workflow.
          </div>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            {suggestions.map((suggestion) => {
              const busy = suggestionActionId === suggestion.id
              const statusTone = suggestion.status === 'approved'
                ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20'
                : suggestion.status === 'rejected'
                  ? 'bg-white/[0.04] text-text-3/65 border-white/[0.08]'
                  : 'bg-amber-500/10 text-amber-300 border-amber-500/20'
              return (
                <div key={suggestion.id} className="rounded-[14px] border border-white/[0.06] bg-bg/50 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-display text-[14px] font-600 text-text truncate">{suggestion.name}</div>
                      <div className="text-[11px] text-text-3/55 mt-1 truncate">
                        {suggestion.sourceSessionName || suggestion.sourceSessionId}
                        {suggestion.sourceAgentName ? ` · ${suggestion.sourceAgentName}` : ''}
                      </div>
                    </div>
                    <span className={`shrink-0 rounded-full border px-2 py-1 text-[10px] font-700 uppercase tracking-[0.08em] ${statusTone}`}>
                      {suggestion.status}
                    </span>
                  </div>
                  {suggestion.description && (
                    <p className="mt-2 text-[12px] text-text-3/70">{suggestion.description}</p>
                  )}
                  {suggestion.summary && (
                    <p className="mt-2 text-[12px] text-text-3/60">Summary: {suggestion.summary}</p>
                  )}
                  {suggestion.rationale && (
                    <p className="mt-1.5 text-[12px] text-text-3/60">Why reusable: {suggestion.rationale}</p>
                  )}
                  {suggestion.sourceSnippet && (
                    <div className="mt-3 rounded-[10px] border border-white/[0.06] bg-surface px-3 py-2 text-[11px] text-text-3/65 whitespace-pre-wrap">
                      {suggestion.sourceSnippet}
                    </div>
                  )}
                  {suggestion.tags && suggestion.tags.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {suggestion.tags.map((tag) => (
                        <Badge key={`${suggestion.id}-${tag}`} variant="secondary" className="text-[10px] px-1.5 py-0">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {suggestion.status === 'draft' && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        onClick={() => handleApproveSuggestion(suggestion.id)}
                        disabled={busy}
                        className="px-3 py-1.5 rounded-[9px] text-[12px] font-600 bg-accent-soft text-accent-bright border border-accent-bright/20 hover:bg-accent-soft/80 transition-all cursor-pointer disabled:opacity-50"
                        style={{ fontFamily: 'inherit' }}
                      >
                        {busy ? 'Working…' : 'Approve'}
                      </button>
                      <button
                        onClick={() => handleRejectSuggestion(suggestion.id)}
                        disabled={busy}
                        className="px-3 py-1.5 rounded-[9px] text-[12px] font-600 bg-transparent text-text-3 border border-white/[0.08] hover:bg-white/[0.04] transition-all cursor-pointer disabled:opacity-50"
                        style={{ fontFamily: 'inherit' }}
                      >
                        Dismiss
                      </button>
                    </div>
                  )}
                  {suggestion.status !== 'draft' && suggestion.createdSkillId && (
                    <div className="mt-3 text-[11px] text-text-3/60">
                      Saved as skill <span className="font-mono text-text-3/85">{suggestion.createdSkillId}</span>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={`flex-1 overflow-y-auto ${inSidebar ? 'px-3 pb-4' : 'px-5 pb-6'}`}>
      {/* Sidebar: ClawHub button + Sheet */}
      {inSidebar && (
        <div style={{ animation: 'fade-up 0.4s var(--ease-spring)' }}>
          <button
            onClick={() => setClawHubOpen(true)}
            className="w-full mb-3 py-2.5 px-4 rounded-[12px] border border-dashed border-white/[0.1] text-[13px] font-600 text-text-3 hover:text-accent-bright hover:border-accent-bright/30 transition-all cursor-pointer bg-transparent relative overflow-hidden group/hub"
            style={{ fontFamily: 'inherit' }}
          >
            <span className="relative z-10">Browse ClawHub Skills</span>
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent -translate-x-full group-hover/hub:animate-[shimmer-bar_2s_infinite]" />
          </button>
          <ClawHubBrowser open={clawHubOpen} onOpenChange={setClawHubOpen} onInstalled={() => loadSkills()} />
        </div>
      )}

      {/* Full-width: tabs */}
      {!inSidebar && (
        <>
        {renderSuggestions()}
        <div className="flex gap-1 mb-4" style={{ animation: 'fade-up 0.4s var(--ease-spring)' }}>
          <button onClick={() => setTab('skills')} className={tabClass('skills')} style={{ fontFamily: 'inherit' }}>
            Skill Library
          </button>
          <button onClick={() => setTab('clawhub')} className={tabClass('clawhub')} style={{ fontFamily: 'inherit' }}>
            ClawHub
          </button>
        </div>
        </>
      )}

      {(!inSidebar && tab === 'clawhub') ? renderClawHub() : (
        skillList.length === 0 ? (
          <div className="text-center py-12" style={{ animation: 'fade-up 0.5s var(--ease-spring)' }}>
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
            {skillList.map((skill, idx) => {
              const skillScope = skill.scope || 'global'
              const skillAgentIds = skill.agentIds || []
              const scopeLabel = skillScope === 'global' ? 'Global' : `${skillAgentIds.length} agent(s)`
              const scopedAgents = skillScope === 'agent'
                ? skillAgentIds.map((id) => agents[id]).filter(Boolean)
                : []
              const securityTone = skill.security?.level === 'high'
                ? 'bg-red-500/10 text-red-300 border-red-500/20'
                : skill.security?.level === 'medium'
                  ? 'bg-amber-500/10 text-amber-300 border-amber-500/20'
                  : 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20'
              const requirementCount = (skill.skillRequirements?.env?.length || 0)
                + (skill.skillRequirements?.bins?.length || 0)
                + (skill.skillRequirements?.config?.length || 0)
              return (
                <div
                  key={skill.id}
                  onClick={() => handleEdit(skill.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      handleEdit(skill.id)
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  className="w-full text-left p-4 rounded-[14px] border border-white/[0.06] bg-surface hover:bg-surface-2 transition-all cursor-pointer hover:border-white/[0.12] hover:scale-[1.01]"
                  style={{
                    fontFamily: 'inherit',
                    animation: 'spring-in 0.5s var(--ease-spring) both',
                    animationDelay: `${idx * 0.05}s`
                  }}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-display text-[14px] font-600 text-text truncate">{skill.name}</span>
                    <div className="flex items-center gap-2 shrink-0 ml-2">
                      <span className="text-[10px] font-mono text-text-3/50">{skill.filename}</span>
                      {!inSidebar && (
                        <button
                          type="button"
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
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {skill.version && (
                      <span className="rounded-full border border-white/[0.08] px-2 py-1 text-[10px] font-700 text-text-3/70">
                        v{skill.version}
                      </span>
                    )}
                    {typeof requirementCount === 'number' && requirementCount > 0 && (
                      <span className="rounded-full border border-white/[0.08] px-2 py-1 text-[10px] font-700 text-text-3/70">
                        {requirementCount} reqs
                      </span>
                    )}
                    {skill.security && (
                      <span className={`rounded-full border px-2 py-1 text-[10px] font-700 uppercase tracking-[0.08em] ${securityTone}`}>
                        {skill.security.level}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-1.5">
                    <span className="text-[11px] text-text-3/70">{skill.content.length} chars</span>
                    <span className="text-[11px] text-text-3/60">·</span>
                    <span className={`text-[10px] font-600 ${
                      skillScope === 'global' ? 'text-emerald-400' : 'text-amber-400'
                    }`}>
                      {scopeLabel}
                    </span>
                  </div>
                  {scopedAgents.length > 0 && (
                    <div className="flex items-center gap-1.5 mt-1.5">
                      <div className="flex items-center -space-x-1.5">
                        {scopedAgents.slice(0, 5).map((agent) => (
                          <AgentAvatar key={agent.id} seed={agent.avatarSeed} avatarUrl={agent.avatarUrl} name={agent.name} size={16} className="ring-1 ring-surface" />
                        ))}
                      </div>
                      {scopedAgents.length > 5 && (
                        <span className="text-[10px] font-600 text-text-3/60 ml-0.5">+{scopedAgents.length - 5}</span>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )
      )}
    </div>
  )
}
