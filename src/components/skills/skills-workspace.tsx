'use client'

import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import { toast } from 'sonner'
import { dedup } from '@/lib/shared-utils'
import { useMountedRef } from '@/hooks/use-mounted-ref'
import { useAppStore } from '@/stores/use-app-store'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { CodeBlock } from '@/components/chat/code-block'
import { ConfirmDialog } from '@/components/shared/confirm-dialog'
import type {
  Agent,
  ClawHubSkill,
  Skill,
  SkillSuggestion,
} from '@/types'
import { useAgentsQuery } from '@/features/agents/queries'
import {
  useApproveSkillSuggestionMutation,
  useClawHubPreviewMutation,
  useClawHubSearchMutation,
  useDeleteSkillMutation,
  useGenerateSkillSuggestionMutation,
  useInstallClawHubSkillMutation,
  useRejectSkillSuggestionMutation,
  useSkillsQuery,
  useSkillSuggestionsQuery,
  type ClawHubPreview,
} from '@/features/skills/queries'

type SkillScopeFilter = 'all' | 'global' | 'agent'
type SkillSort = 'updated' | 'name'
type HubSort = 'popular' | 'name' | 'updated'

const HUB_PAGE_SIZE = 18

export function SkillsWorkspace() {
  const { t } = useTranslation()
  const router = useRouter()
  const searchParams = useSearchParams()
  const mountedRef = useMountedRef()
  const skillsQuery = useSkillsQuery()
  const skills = useMemo(() => skillsQuery.data ?? {}, [skillsQuery.data])
  const agentsQuery = useAgentsQuery()
  const suggestionsQuery = useSkillSuggestionsQuery()
  const generateSuggestionMutation = useGenerateSkillSuggestionMutation()
  const approveSuggestionMutation = useApproveSkillSuggestionMutation()
  const rejectSuggestionMutation = useRejectSkillSuggestionMutation()
  const clawHubSearchMutation = useClawHubSearchMutation()
  const clawHubPreviewMutation = useClawHubPreviewMutation()
  const installClawHubSkillMutation = useInstallClawHubSkillMutation()
  const deleteSkillMutation = useDeleteSkillMutation()
  const currentAgentId = useAppStore((s) => s.currentAgentId)
  const activeProjectFilter = useAppStore((s) => s.activeProjectFilter)
  const setSkillSheetOpen = useAppStore((s) => s.setSkillSheetOpen)
  const setEditingSkillId = useAppStore((s) => s.setEditingSkillId)

  const suggestions = suggestionsQuery.data ?? []
  const agents = agentsQuery.data ?? {}

  const activeTab = searchParams.get('tab') === 'clawhub' ? 'clawhub' : 'skills'
  const selectedSkillId = activeTab === 'skills' ? searchParams.get('skill') : null

  const [libraryQuery, setLibraryQuery] = useState('')
  const [libraryScope, setLibraryScope] = useState<SkillScopeFilter>('all')
  const [librarySort, setLibrarySort] = useState<SkillSort>('updated')
  const [activeLibraryTag, setActiveLibraryTag] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Skill | null>(null)
  const [deletingSkillId, setDeletingSkillId] = useState<string | null>(null)

  const [suggestionActionId, setSuggestionActionId] = useState<string | null>(null)
  const [generatingSuggestion, setGeneratingSuggestion] = useState(false)

  const [hubQuery, setHubQuery] = useState('')
  const [hubSort, setHubSort] = useState<HubSort>('popular')
  const [activeHubTag, setActiveHubTag] = useState<string | null>(null)
  const [hubSkills, setHubSkills] = useState<ClawHubSkill[]>([])
  const [hubPage, setHubPage] = useState(1)
  const [hubTotal, setHubTotal] = useState(0)
  const [hubNextCursor, setHubNextCursor] = useState<string | null>(null)
  const [hubLastQuery, setHubLastQuery] = useState<string | null>(null)
  const [hubLoading, setHubLoading] = useState(false)
  const [hubSearched, setHubSearched] = useState(false)
  const [hubError, setHubError] = useState<string | null>(null)
  const [selectedHubSkill, setSelectedHubSkill] = useState<ClawHubSkill | null>(null)
  const [hubPreviewCache, setHubPreviewCache] = useState<Record<string, ClawHubPreview>>({})
  const [hubPreviewLoadingId, setHubPreviewLoadingId] = useState<string | null>(null)
  const [hubPreviewError, setHubPreviewError] = useState<string | null>(null)
  const [installingHubId, setInstallingHubId] = useState<string | null>(null)
  const hubSearchRequestIdRef = useRef(0)

  useEffect(() => {
    if (activeTab !== 'clawhub') {
      setSelectedHubSkill(null)
      setHubPreviewError(null)
    }
  }, [activeTab])

  const skillList = useMemo(() => {
    return Object.values(skills).filter((skill) => !activeProjectFilter || skill.projectId === activeProjectFilter)
  }, [activeProjectFilter, skills])

  const selectedSkill = selectedSkillId ? skills[selectedSkillId] ?? null : null
  const currentSessionId = currentAgentId ? agents[currentAgentId]?.threadSessionId || null : null

  const setPageState = useCallback((patch: Record<string, string | null | undefined>, mode: 'push' | 'replace' = 'push') => {
    const next = new URLSearchParams(searchParams.toString())
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === undefined || value === '') {
        next.delete(key)
      } else {
        next.set(key, value)
      }
    }
    const url = next.toString() ? `/skills?${next.toString()}` : '/skills'
    if (mode === 'replace') {
      router.replace(url)
      return
    }
    router.push(url)
  }, [router, searchParams])

  const openSkillEditor = useCallback((skillId?: string | null) => {
    setEditingSkillId(skillId || null)
    setSkillSheetOpen(true)
  }, [setEditingSkillId, setSkillSheetOpen])

  const handleGenerateSuggestion = useCallback(async () => {
    if (!currentSessionId) {
      toast.error(t('openChatFirst'))
      return
    }
    setGeneratingSuggestion(true)
    try {
      await generateSuggestionMutation.mutateAsync(currentSessionId)
      toast.success(t('draftSuggestionSuccess'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('draftSuggestionFailed'))
    } finally {
      if (mountedRef.current) setGeneratingSuggestion(false)
    }
  }, [currentSessionId, generateSuggestionMutation, mountedRef, t])

  const handleApproveSuggestion = useCallback(async (id: string) => {
    setSuggestionActionId(id)
    try {
      await approveSuggestionMutation.mutateAsync(id)
      toast.success(t('approveSuggestionSuccess'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('approveSuggestionFailed'))
    } finally {
      if (mountedRef.current) setSuggestionActionId(null)
    }
  }, [approveSuggestionMutation, mountedRef, t])

  const handleRejectSuggestion = useCallback(async (id: string) => {
    setSuggestionActionId(id)
    try {
      await rejectSuggestionMutation.mutateAsync(id)
      toast.success(t('rejectSuggestionSuccess'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('rejectSuggestionFailed'))
    } finally {
      if (mountedRef.current) setSuggestionActionId(null)
    }
  }, [mountedRef, rejectSuggestionMutation, t])

  const searchHub = useCallback(async (query: string, page: number, append = false, cursor?: string | null) => {
    const requestId = hubSearchRequestIdRef.current + 1
    hubSearchRequestIdRef.current = requestId
    setHubLoading(true)
    setHubError(null)

    try {
      const response = await clawHubSearchMutation.mutateAsync({
        query,
        page,
        limit: HUB_PAGE_SIZE,
        cursor,
      })
      if (!mountedRef.current || requestId !== hubSearchRequestIdRef.current) return

      if (response.error) setHubError(response.error)
      setHubSkills((prev) => dedupeHubSkills(append ? [...prev, ...response.skills] : response.skills))
      setHubTotal(response.total)
      setHubPage(response.page)
      setHubNextCursor(response.nextCursor ?? null)
      setHubLastQuery(query)
      setHubSearched(true)
    } catch (err) {
      if (!mountedRef.current || requestId !== hubSearchRequestIdRef.current) return
      setHubError(err instanceof Error ? err.message : t('clawHubSearchFailed'))
    } finally {
      if (mountedRef.current && requestId === hubSearchRequestIdRef.current) setHubLoading(false)
    }
  }, [clawHubSearchMutation, mountedRef, t])

  useEffect(() => {
    if (activeTab !== 'clawhub' || selectedHubSkill) return
    if (hubSearched && hubQuery === (hubLastQuery || '')) return
    const timer = window.setTimeout(() => {
      void searchHub(hubQuery, 1)
    }, hubQuery.trim() ? 240 : 0)
    return () => window.clearTimeout(timer)
  }, [activeTab, hubLastQuery, hubQuery, hubSearched, searchHub, selectedHubSkill])

  const selectedHubPreview = selectedHubSkill ? hubPreviewCache[selectedHubSkill.id] || null : null

  useEffect(() => {
    if (!selectedHubSkill || hubPreviewCache[selectedHubSkill.id]) return
    let active = true
    setHubPreviewLoadingId(selectedHubSkill.id)
    setHubPreviewError(null)

    void clawHubPreviewMutation.mutateAsync({
      name: selectedHubSkill.name,
      description: selectedHubSkill.description,
      author: selectedHubSkill.author,
      tags: selectedHubSkill.tags,
      url: selectedHubSkill.url,
    }).then((preview) => {
      if (!active || !mountedRef.current) return
      setHubPreviewCache((prev) => ({ ...prev, [selectedHubSkill.id]: preview }))
    }).catch((err) => {
      if (!active || !mountedRef.current) return
      setHubPreviewError(err instanceof Error ? err.message : t('previewLoadFailed'))
    }).finally(() => {
      if (active && mountedRef.current) setHubPreviewLoadingId(null)
    })

    return () => {
      active = false
    }
  }, [clawHubPreviewMutation, hubPreviewCache, mountedRef, selectedHubSkill, t])

  const installedHubIds = useMemo(() => {
    const ids = new Set<string>()
    for (const skill of skillList) {
      const candidates = [skill.sourceUrl, skill.homepage]
      for (const candidate of candidates) {
        const slug = extractClawHubSlug(candidate)
        if (slug) ids.add(slug)
      }
    }
    return ids
  }, [skillList])

  const libraryTags = useMemo(() => sortTagsByFrequency(skillList.flatMap((skill) => skill.tags || [])).slice(0, 10), [skillList])
  const hubTags = useMemo(() => sortTagsByFrequency(hubSkills.flatMap((skill) => skill.tags || [])).slice(0, 10), [hubSkills])

  const filteredSkills = useMemo(() => {
    const query = libraryQuery.trim().toLowerCase()
    const filtered = skillList.filter((skill) => {
      if (libraryScope === 'global' && (skill.scope || 'global') !== 'global') return false
      if (libraryScope === 'agent' && (skill.scope || 'global') !== 'agent') return false
      if (activeLibraryTag && !(skill.tags || []).includes(activeLibraryTag)) return false
      if (!query) return true

      const haystack = [
        skill.name,
        skill.filename,
        skill.description || '',
        plainTextExcerpt(skill.content, 280),
        ...(skill.tags || []),
        ...(skill.toolNames || []),
        ...(skill.capabilities || []),
      ].join(' ').toLowerCase()

      return haystack.includes(query)
    })

    return filtered.sort((left, right) => {
      if (librarySort === 'name') return left.name.localeCompare(right.name)
      return (right.updatedAt || 0) - (left.updatedAt || 0)
    })
  }, [activeLibraryTag, libraryQuery, libraryScope, librarySort, skillList])

  const filteredHubSkills = useMemo(() => {
    const filtered = hubSkills.filter((skill) => {
      if (activeHubTag && !(skill.tags || []).includes(activeHubTag)) return false
      return true
    })

    return filtered.sort((left, right) => {
      if (hubSort === 'name') return left.name.localeCompare(right.name)
      if (hubSort === 'updated') return (right.updatedAt || 0) - (left.updatedAt || 0)
      return (right.downloads || 0) - (left.downloads || 0)
    })
  }, [activeHubTag, hubSkills, hubSort])

  const hasMoreHubResults = Boolean(hubNextCursor) || hubSkills.length < hubTotal
  const skillCount = skillList.length
  const draftCount = suggestions.filter((suggestion) => suggestion.status === 'draft').length

  const handleInstallHubSkill = useCallback(async (skill: ClawHubSkill) => {
    setInstallingHubId(skill.id)
    try {
      await installClawHubSkillMutation.mutateAsync({
        name: skill.name,
        description: skill.description,
        url: skill.url,
        author: skill.author,
        tags: skill.tags,
        content: hubPreviewCache[skill.id]?.content,
      })
      toast.success(`Installed "${skill.name}"`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('installFailed'))
    } finally {
      if (mountedRef.current) setInstallingHubId(null)
    }
  }, [hubPreviewCache, installClawHubSkillMutation, mountedRef, t])

  const confirmDeleteSkill = useCallback(async () => {
    if (!deleteTarget) return
    setDeletingSkillId(deleteTarget.id)
    try {
      await deleteSkillMutation.mutateAsync(deleteTarget.id)
      toast.success(t('skillDeleted'))
      if (selectedSkillId === deleteTarget.id) {
        setPageState({ skill: null }, 'replace')
      }
      setDeleteTarget(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('skillDeleteFailed'))
    } finally {
      if (mountedRef.current) setDeletingSkillId(null)
    }
  }, [deleteSkillMutation, deleteTarget, mountedRef, selectedSkillId, setPageState, t])

  if (skillsQuery.isPending || agentsQuery.isPending) {
    return (
      <div className="flex-1 flex items-center justify-center px-6">
        <div className="flex items-center gap-3 text-[13px] text-text-3/65">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/[0.12] border-t-accent-bright" />
          {t('loadingSkillsLibrary')}
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="flex-1 overflow-y-auto px-5 pb-8 md:px-6">
        <section className="relative overflow-hidden rounded-[28px] border border-white/[0.08] bg-[radial-gradient(circle_at_top_left,rgba(120,180,255,0.18),transparent_38%),radial-gradient(circle_at_bottom_right,rgba(16,185,129,0.14),transparent_34%),rgba(255,255,255,0.02)] px-5 py-5 md:px-7 md:py-6">
          <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(255,255,255,0.06),transparent_28%,transparent_72%,rgba(255,255,255,0.04))]" />
          <div className="relative z-10">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
              <div className="max-w-3xl">
                <div className="text-[11px] font-700 uppercase tracking-[0.16em] text-text-3/70">
                  {t('skillsAndClawHub')}
                </div>
                <h1 className="mt-2 font-display text-[28px] font-700 tracking-[-0.04em] text-text md:text-[34px]">
                  {t('skillsHeroTitle')}
                </h1>
                <p className="mt-3 max-w-2xl text-[14px] leading-[1.7] text-text-2/80">
                  {t('skillsHeroDesc')}
                </p>
              </div>

              <div className="flex flex-wrap gap-2 lg:justify-end">
                <ActionButton label={t('newSkill')} tone="primary" onClick={() => openSkillEditor(null)} />
                <ActionButton
                  label={activeTab === 'clawhub' ? t('backToLibrary') : t('openClawHub')}
                  tone="secondary"
                  onClick={() => {
                    if (activeTab === 'clawhub') {
                      setSelectedHubSkill(null)
                      setPageState({ tab: 'skills', skill: null })
                      return
                    }
                    setPageState({ tab: 'clawhub', skill: null })
                  }}
                />
                <ActionButton
                  label={generatingSuggestion ? t('drafting') : t('draftFromCurrentChat')}
                  tone="ghost"
                  disabled={generatingSuggestion}
                  onClick={() => { void handleGenerateSuggestion() }}
                />
              </div>
            </div>

            <div className="mt-5 flex flex-wrap gap-2">
              <QuickStatPill label={t('installedSkills')} value={skillCount} />
              <QuickStatPill label={t('draftSuggestions')} value={draftCount} />
              <QuickStatPill label={t('marketplaceResults')} value={hubSearched ? hubTotal : 0} muted={!hubSearched} />
              {activeProjectFilter ? <QuickStatPill label={t('projectFilter')} value={1} /> : null}
            </div>
          </div>
        </section>

        <div className="mt-5 flex flex-wrap items-center gap-2 border-b border-white/[0.08] pb-px">
          <TabButton
            active={activeTab === 'skills'}
            count={skillCount}
            onClick={() => {
              setSelectedHubSkill(null)
              setPageState({ tab: 'skills' })
            }}
          >
            {t('library')}
          </TabButton>
          <TabButton
            active={activeTab === 'clawhub'}
            count={hubSearched ? hubTotal : undefined}
            onClick={() => setPageState({ tab: 'clawhub', skill: null })}
          >
            {t('clawHub')}
          </TabButton>
        </div>

        {activeTab === 'skills' && selectedSkill && (
          <SkillDetailView
            skill={selectedSkill}
            agents={agents}
            onBack={() => setPageState({ skill: null })}
            onEdit={() => openSkillEditor(selectedSkill.id)}
            onDelete={() => setDeleteTarget(selectedSkill)}
          />
        )}

        {activeTab === 'skills' && selectedSkillId && !selectedSkill && (
          <EmptyState
            title={t('skillNotAvailable')}
            body={t('skillNotAvailableDesc')}
            actionLabel={t('backToLibrary')}
            onAction={() => setPageState({ skill: null }, 'replace')}
          />
        )}

        {activeTab === 'skills' && !selectedSkillId && (
          <div className="space-y-6 pt-5">
            <div className="rounded-[22px] border border-white/[0.08] bg-surface/70 p-4 md:p-5">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <div className="text-[11px] font-700 uppercase tracking-[0.14em] text-text-3/65">{t('library')}</div>
                  <p className="mt-1 text-[13px] text-text-3/75">
                    {t('librarySearchDesc')}
                  </p>
                </div>
                <div className="grid gap-2 sm:grid-cols-[minmax(220px,1fr)_auto_auto]">
                  <SearchField
                    value={libraryQuery}
                    onChange={setLibraryQuery}
                    placeholder={t('searchSkillsPlaceholder')}
                  />
                  <select
                    value={libraryScope}
                    onChange={(event) => setLibraryScope(event.target.value as SkillScopeFilter)}
                    className={selectClassName}
                  >
                    <option value="all">{t('allScopes')}</option>
                    <option value="global">{t('global')}</option>
                    <option value="agent">{t('agentOnly')}</option>
                  </select>
                  <select
                    value={librarySort}
                    onChange={(event) => setLibrarySort(event.target.value as SkillSort)}
                    className={selectClassName}
                  >
                    <option value="updated">{t('recentlyUpdated')}</option>
                    <option value="name">{t('name')}</option>
                  </select>
                </div>
              </div>

              <FilterRow
                label={t('tags')}
                active={activeLibraryTag}
                items={libraryTags}
                onToggle={(tag) => setActiveLibraryTag(activeLibraryTag === tag ? null : tag)}
                onClear={() => setActiveLibraryTag(null)}
              />

              <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
                <div className="text-[12px] text-text-3/70">
                  {t('showing')} <span className="font-700 text-text">{filteredSkills.length}</span> {t('of')} {skillCount} {t('skills')}
                </div>
                <div className="flex flex-wrap gap-2">
                  {draftCount > 0 ? (
                    <MiniBadge tone="warning">{t('draftSuggestionCount', { count: draftCount })}</MiniBadge>
                  ) : null}
                  {libraryQuery || activeLibraryTag || libraryScope !== 'all' ? (
                    <button
                      type="button"
                      onClick={() => {
                        setLibraryQuery('')
                        setLibraryScope('all')
                        setActiveLibraryTag(null)
                      }}
                      className="cursor-pointer rounded-full border border-white/[0.08] px-3 py-1 text-[11px] font-600 text-text-3/80 transition-colors hover:border-white/[0.14] hover:text-text"
                    >
                      {t('clearFilters')}
                    </button>
                  ) : null}
                </div>
              </div>
            </div>

            {filteredSkills.length === 0 ? (
              <EmptyState
                title={skillCount === 0 ? t('noSkillsYet') : t('noSkillsMatch')}
                body={skillCount === 0
                  ? t('noSkillsYetDesc')
                  : t('noSkillsMatchDesc')}
                actionLabel={skillCount === 0 ? t('createSkill') : t('clearFilters')}
                onAction={() => {
                  if (skillCount === 0) {
                    openSkillEditor(null)
                    return
                  }
                  setLibraryQuery('')
                  setLibraryScope('all')
                  setActiveLibraryTag(null)
                }}
                secondaryLabel={skillCount === 0 ? t('browseClawHub') : undefined}
                onSecondaryAction={skillCount === 0 ? (() => setPageState({ tab: 'clawhub', skill: null })) : undefined}
              />
            ) : (
              <div className="grid grid-cols-1 gap-3 xl:grid-cols-2 2xl:grid-cols-3">
                {filteredSkills.map((skill) => (
                  <SkillCard
                    key={skill.id}
                    skill={skill}
                    agents={agents}
                    onOpen={() => setPageState({ tab: 'skills', skill: skill.id })}
                    onEdit={() => openSkillEditor(skill.id)}
                  />
                ))}
              </div>
            )}

            {(suggestionsQuery.isPending || draftCount > 0) ? (
              <SuggestionsPanel
                suggestions={suggestions}
                loading={suggestionsQuery.isPending}
                busyId={suggestionActionId}
                onApprove={handleApproveSuggestion}
                onReject={handleRejectSuggestion}
              />
            ) : null}
          </div>
        )}

        {activeTab === 'clawhub' && !selectedHubSkill && (
          <div className="space-y-6 pt-5">
            <section className="rounded-[22px] border border-white/[0.08] bg-surface/70 p-4 md:p-5">
              <div>
                <div className="text-[11px] font-700 uppercase tracking-[0.14em] text-text-3/65">{t('clawHub')}</div>
                <p className="mt-1 max-w-2xl text-[13px] leading-[1.7] text-text-3/75">
                  {t('clawHubSearchDesc')}
                </p>

                <div className="mt-4 grid gap-2 sm:grid-cols-[minmax(240px,1fr)_auto_auto]">
                  <SearchField
                    value={hubQuery}
                    onChange={setHubQuery}
                    placeholder={t('searchClawHubPlaceholder')}
                  />
                  <select
                    value={hubSort}
                    onChange={(event) => setHubSort(event.target.value as HubSort)}
                    className={selectClassName}
                  >
                    <option value="popular">{t('mostInstalled')}</option>
                    <option value="updated">{t('recentlyUpdated')}</option>
                    <option value="name">{t('name')}</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => { void searchHub(hubQuery, 1) }}
                    className={secondaryButtonClassName}
                  >
                    {t('searchNow')}
                  </button>
                </div>

                <FilterRow
                  label={t('popularTags')}
                  active={activeHubTag}
                  items={hubTags}
                  onToggle={(tag) => setActiveHubTag(activeHubTag === tag ? null : tag)}
                  onClear={() => setActiveHubTag(null)}
                />

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <MiniBadge>{hubSearched ? `${hubTotal} ${t('results')}` : t('searchToLoadCatalog')}</MiniBadge>
                  <MiniBadge>{installedHubIds.size} {t('alreadyInstalled')}</MiniBadge>
                  <MiniBadge>{hubLoading ? t('refreshing') : t('liveFromClawHub')}</MiniBadge>
                </div>
              </div>
            </section>

            {hubError ? (
              <EmptyState
                title={t('clawHubSearchFailed')}
                body={hubError}
                actionLabel={t('retrySearch')}
                onAction={() => { void searchHub(hubQuery, 1) }}
              />
            ) : null}

            {!hubError && hubSearched && filteredHubSkills.length === 0 && !hubLoading ? (
              <EmptyState
                title={t('noMarketplaceSkillsMatch')}
                body={hubQuery.trim()
                  ? t('noMarketplaceMatchDesc')
                  : t('clawHubEmpty')}
                actionLabel={t('clearFilters')}
                onAction={() => {
                  setHubQuery('')
                  setActiveHubTag(null)
                }}
              />
            ) : null}

            {hubLoading && !hubSearched ? (
              <div className="flex items-center justify-center py-16 text-[13px] text-text-3/65">
                <span className="mr-3 h-4 w-4 animate-spin rounded-full border-2 border-white/[0.12] border-t-accent-bright" />
                {t('loadingMarketplace')}
              </div>
            ) : null}

            {filteredHubSkills.length > 0 ? (
              <div className="grid grid-cols-1 gap-3 xl:grid-cols-2 2xl:grid-cols-3">
                {filteredHubSkills.map((skill) => (
                  <HubSkillCard
                    key={skill.id}
                    skill={skill}
                    installed={installedHubIds.has(skill.id)}
                    busy={installingHubId === skill.id}
                    onOpen={() => setSelectedHubSkill(skill)}
                    onInstall={() => { void handleInstallHubSkill(skill) }}
                  />
                ))}
              </div>
            ) : null}

            {hasMoreHubResults && filteredHubSkills.length > 0 ? (
              <div className="flex justify-center">
                <button
                  type="button"
                  disabled={hubLoading}
                  onClick={() => { void searchHub(hubQuery, hubPage + 1, true, hubNextCursor) }}
                  className={secondaryButtonClassName}
                >
                  {hubLoading ? t('loading') : t('loadMore')}
                </button>
              </div>
            ) : null}
          </div>
        )}

        {activeTab === 'clawhub' && selectedHubSkill && (
          <HubSkillDetailView
            skill={selectedHubSkill}
            preview={selectedHubPreview}
            previewLoading={hubPreviewLoadingId === selectedHubSkill.id}
            previewError={hubPreviewError}
            installed={installedHubIds.has(selectedHubSkill.id)}
            installBusy={installingHubId === selectedHubSkill.id}
            onBack={() => setSelectedHubSkill(null)}
            onInstall={() => { void handleInstallHubSkill(selectedHubSkill) }}
          />
        )}
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        title={t('deleteSkill')}
        message={deleteTarget ? `${t('deleteConfirmMessage')} "${deleteTarget.name}"?` : ''}
        confirmLabel={deletingSkillId ? t('deleting') : t('delete')}
        confirmDisabled={!!deletingSkillId}
        cancelDisabled={!!deletingSkillId}
        danger
        onConfirm={() => { void confirmDeleteSkill() }}
        onCancel={() => { if (!deletingSkillId) setDeleteTarget(null) }}
      />
    </>
  )
}

function SkillDetailView({
  skill,
  agents,
  onBack,
  onEdit,
  onDelete,
}: {
  skill: Skill
  agents: Record<string, Agent>
  onBack: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const scopedAgents = (skill.agentIds || []).map((id) => agents[id]).filter(Boolean)
  const scopeLabel = (skill.scope || 'global') === 'agent' ? `${scopedAgents.length} ${t('agent')}${scopedAgents.length === 1 ? '' : 's'}` : t('global')
  const requirementTotal = countRequirements(skill)
  const plainPreview = skill.description || plainTextExcerpt(skill.content, 240)

  return (
    <div className="space-y-6 pt-5">
      <BackButton label={t('backToLibrary')} onClick={onBack} />

      <section className="rounded-[26px] border border-white/[0.08] bg-surface/70 p-5 md:p-6">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="max-w-3xl">
            <div className="text-[11px] font-700 uppercase tracking-[0.14em] text-text-3/65">
              {t('localSkill')}
            </div>
            <h2 className="mt-2 font-display text-[28px] font-700 tracking-[-0.04em] text-text md:text-[34px]">
              {skill.name}
            </h2>
            <p className="mt-3 text-[14px] leading-[1.7] text-text-2/80">
              {plainPreview || t('noDescriptionProvided')}
            </p>
          </div>

          <div className="flex flex-wrap gap-2 xl:justify-end">
            <ActionButton label={t('editSkill')} tone="primary" onClick={onEdit} />
            {skill.homepage ? (
              <ActionAnchor label={t('homepage')} href={skill.homepage} tone="secondary" />
            ) : null}
            {skill.sourceUrl ? (
              <ActionAnchor label={t('sourceFile')} href={skill.sourceUrl} tone="ghost" />
            ) : null}
            <ActionButton label={t('delete')} tone="danger" onClick={onDelete} />
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <MiniBadge>{scopeLabel}</MiniBadge>
          <MiniBadge>{skill.sourceFormat === 'openclaw' ? t('openClawFormat') : t('plainMarkdown')}</MiniBadge>
          <MiniBadge>{skill.filename}</MiniBadge>
          {skill.version ? <MiniBadge>v{skill.version}</MiniBadge> : null}
          {skill.author ? <MiniBadge>{t('by')} {skill.author}</MiniBadge> : null}
          {requirementTotal > 0 ? <MiniBadge>{requirementTotal} {t('setupItems')}</MiniBadge> : null}
          {skill.security ? <MiniBadge tone={securityTone(skill.security.level)}>{skill.security.level} {t('risk')}</MiniBadge> : null}
        </div>

        <div className="mt-6 grid gap-3 lg:grid-cols-3">
          <DetailCard
            title={t('overview')}
            body={`${skill.content.length.toLocaleString()} ${t('charactersOfInstructions')}\n${t('updated')} ${formatTimestamp(skill.updatedAt || skill.createdAt)}.`}
          />
          <DetailCard
            title={t('toolsAndCapabilities')}
            body={buildCapabilitySummary(skill)}
          />
          <DetailCard
            title={t('access')}
            body={(skill.scope || 'global') === 'agent'
              ? (scopedAgents.length
                ? `${t('availableTo')} ${scopedAgents.map((agent) => agent.name).join(', ')}.`
                : t('restrictedToSelectedAgents'))
              : t('availableToAllAgents')}
          />
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(300px,0.85fr)]">
        <section className="rounded-[22px] border border-white/[0.08] bg-surface/65 p-4 md:p-5">
          <SectionHeading
            title={t('markdownPreview')}
            subtitle={t('markdownPreviewDesc')}
          />
          <MarkdownPreview content={skill.content} />
        </section>

        <div className="space-y-4">
          <section className="rounded-[22px] border border-white/[0.08] bg-surface/65 p-4 md:p-5">
            <SectionHeading
              title={t('declaredMetadata')}
              subtitle={t('metadataDesc')}
            />
            <MetadataGrid skill={skill} />
          </section>

          <section className="rounded-[22px] border border-white/[0.08] bg-surface/65 p-4 md:p-5">
            <SectionHeading
              title={t('setupAndSafety')}
              subtitle={t('setupAndSafetyDesc')}
            />
            <SetupOverview skill={skill} />
          </section>

          {(skill.scope || 'global') === 'agent' ? (
            <section className="rounded-[22px] border border-white/[0.08] bg-surface/65 p-4 md:p-5">
              <SectionHeading
                title={t('assignedAgents')}
                subtitle={t('assignedAgentsDesc')}
              />
              {scopedAgents.length > 0 ? (
                <div className="space-y-2">
                  {scopedAgents.map((agent) => (
                    <div key={agent.id} className="flex items-center gap-3 rounded-[14px] border border-white/[0.06] bg-bg/50 px-3 py-2.5">
                      <AgentAvatar
                        seed={agent.avatarSeed}
                        avatarUrl={agent.avatarUrl}
                        name={agent.name}
                        size={28}
                      />
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-600 text-text">{agent.name}</div>
                        {agent.description ? (
                          <div className="line-clamp-1 text-[11px] text-text-3/65">{agent.description}</div>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <MutedNote>{t('agentAssignmentsEmpty')}</MutedNote>
              )}
            </section>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function HubSkillDetailView({
  skill,
  preview,
  previewLoading,
  previewError,
  installed,
  installBusy,
  onBack,
  onInstall,
}: {
  skill: ClawHubSkill
  preview: ClawHubPreview | null
  previewLoading: boolean
  previewError: string | null
  installed: boolean
  installBusy: boolean
  onBack: () => void
  onInstall: () => void
}) {
  const { t } = useTranslation()
  const detailDescription = preview?.description || skill.description || t('noDescriptionAvailable')
  const capabilitySummary = preview
    ? buildCapabilitySummary(preview)
    : t('previewWillRevealTools')

  return (
    <div className="space-y-6 pt-5">
      <BackButton label={t('backToMarketplace')} onClick={onBack} />

      <section className="rounded-[26px] border border-white/[0.08] bg-surface/70 p-5 md:p-6">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="max-w-3xl">
            <div className="text-[11px] font-700 uppercase tracking-[0.14em] text-text-3/65">
              {t('clawHubSkill')}
            </div>
            <h2 className="mt-2 font-display text-[28px] font-700 tracking-[-0.04em] text-text md:text-[34px]">
              {skill.name}
            </h2>
            <p className="mt-3 text-[14px] leading-[1.7] text-text-2/80">
              {detailDescription}
            </p>
          </div>

          <div className="flex flex-wrap gap-2 xl:justify-end">
            <ActionAnchor label={t('openListing')} href={skill.url} tone="secondary" />
            <ActionButton
              label={installed ? t('installed') : installBusy ? t('installing') : t('installSkill')}
              tone="primary"
              disabled={installed || installBusy}
              onClick={onInstall}
            />
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <MiniBadge>{skill.downloads.toLocaleString()} {t('installs')}</MiniBadge>
          {typeof skill.stars === 'number' && skill.stars > 0 ? <MiniBadge>{skill.stars.toLocaleString()} {t('stars')}</MiniBadge> : null}
          <MiniBadge>v{preview?.version || skill.version}</MiniBadge>
          <MiniBadge>{t('by')} {preview?.author || skill.author}</MiniBadge>
          {skill.updatedAt ? <MiniBadge>{t('updated')} {formatTimestamp(skill.updatedAt)}</MiniBadge> : null}
          {preview?.security ? <MiniBadge tone={securityTone(preview.security.level)}>{preview.security.level} {t('risk')}</MiniBadge> : null}
        </div>

        <div className="mt-6 grid gap-3 lg:grid-cols-3">
          <DetailCard title={t('marketplace')} body={t('marketplaceDesc')} />
          <DetailCard title={t('capabilities')} body={capabilitySummary} />
          <DetailCard
            title={t('setup')}
            body={preview ? buildSetupSummary(preview) : t('setupDesc')}
          />
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(300px,0.85fr)]">
        <section className="rounded-[22px] border border-white/[0.08] bg-surface/65 p-4 md:p-5">
          <SectionHeading
            title={t('skillPreview')}
            subtitle={t('skillPreviewDesc')}
          />
          {previewLoading ? (
            <div className="flex items-center gap-3 rounded-[16px] border border-white/[0.06] bg-bg/50 px-4 py-4 text-[13px] text-text-3/70">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/[0.12] border-t-accent-bright" />
              {t('loadingSkillPreview')}
            </div>
          ) : previewError ? (
            <MutedNote>{previewError}</MutedNote>
          ) : preview?.content ? (
            <MarkdownPreview content={preview.content} />
          ) : (
            <MutedNote>{t('noPreviewAvailable')}</MutedNote>
          )}
        </section>

        <div className="space-y-4">
          <section className="rounded-[22px] border border-white/[0.08] bg-surface/65 p-4 md:p-5">
            <SectionHeading
              title={t('detailSnapshot')}
              subtitle={t('detailSnapshotDesc')}
            />
            <div className="grid gap-2">
              <MetadataRow label={t('listingUrl')} value={skill.url} href={skill.url} />
              <MetadataRow label={t('author')} value={preview?.author || skill.author} />
              <MetadataRow label={t('version')} value={preview?.version || skill.version} />
              {typeof skill.stars === 'number' ? <MetadataRow label={t('stars')} value={skill.stars.toLocaleString()} /> : null}
              {skill.updatedAt ? <MetadataRow label={t('updated')} value={formatTimestamp(skill.updatedAt)} /> : null}
              {skill.changelog ? <MetadataRow label={t('changelog')} value={skill.changelog} /> : null}
            </div>
          </section>

          <section className="rounded-[22px] border border-white/[0.08] bg-surface/65 p-4 md:p-5">
            <SectionHeading
              title={t('setupAndSafety')}
              subtitle={t('setupAndSafetyDesc')}
            />
            {preview ? <SetupOverview skill={preview} /> : <MutedNote>{t('noSetupMetadata')}</MutedNote>}
          </section>
        </div>
      </div>
    </div>
  )
}

function SuggestionsPanel({
  suggestions,
  loading,
  busyId,
  onApprove,
  onReject,
}: {
  suggestions: SkillSuggestion[]
  loading: boolean
  busyId: string | null
  onApprove: (id: string) => void
  onReject: (id: string) => void
}) {
  const { t } = useTranslation()
  const drafts = suggestions.filter((entry) => entry.status === 'draft').slice(0, 3)

  return (
    <section className="rounded-[22px] border border-white/[0.08] bg-surface/70 p-4 md:p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-700 uppercase tracking-[0.14em] text-text-3/65">{t('draftSuggestionsTitle')}</div>
          <p className="mt-1 text-[13px] text-text-3/75">
            {t('draftSuggestionsDesc')}
          </p>
        </div>
        <MiniBadge>{suggestions.filter((entry) => entry.status === 'draft').length} {t('drafts')}</MiniBadge>
      </div>

      {loading ? (
        <div className="mt-4 flex items-center gap-3 rounded-[16px] border border-white/[0.06] bg-bg/50 px-4 py-4 text-[13px] text-text-3/70">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/[0.12] border-t-accent-bright" />
          {t('loadingSuggestionDrafts')}
        </div>
      ) : drafts.length === 0 ? (
        <MutedNote className="mt-4">
          {t('noDraftSuggestions')}
        </MutedNote>
      ) : (
        <div className="mt-4 space-y-3">
          {drafts.map((suggestion) => {
            const busy = busyId === suggestion.id
            return (
              <div key={suggestion.id} className="rounded-[16px] border border-white/[0.06] bg-bg/45 p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-600 text-text">{suggestion.name}</div>
                    <div className="mt-1 text-[11px] text-text-3/65">
                      {suggestion.sourceSessionName || suggestion.sourceSessionId}
                      {suggestion.sourceAgentName ? ` | ${suggestion.sourceAgentName}` : ''}
                    </div>
                  </div>
                  <MiniBadge tone="warning">{t('draft')}</MiniBadge>
                </div>
                {suggestion.description ? (
                  <p className="mt-2 text-[12px] leading-[1.6] text-text-3/75">{suggestion.description}</p>
                ) : null}
                {suggestion.content ? (
                  <details className="mt-3 rounded-[12px] border border-white/[0.06] bg-surface/60 px-3 py-2">
                    <summary className="cursor-pointer list-none text-[11px] font-700 uppercase tracking-[0.12em] text-text-3/65 [&::-webkit-details-marker]:hidden">
                      {t('previewDraftBody')}
                    </summary>
                    <pre className="mt-2 whitespace-pre-wrap text-[11px] leading-[1.6] text-text-3/75">
                      {truncateText(suggestion.content, 800)}
                    </pre>
                  </details>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" onClick={() => onApprove(suggestion.id)} disabled={busy} className={primaryButtonClassName}>
                    {busy ? t('working') : t('approve')}
                  </button>
                  <button type="button" onClick={() => onReject(suggestion.id)} disabled={busy} className={secondaryButtonClassName}>
                    {t('dismiss')}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function SkillCard({
  skill,
  agents,
  onOpen,
  onEdit,
}: {
  skill: Skill
  agents: Record<string, Agent>
  onOpen: () => void
  onEdit: () => void
}) {
  const { t } = useTranslation()
  const scopedAgents = (skill.agentIds || []).map((id) => agents[id]).filter(Boolean)
  const requirementTotal = countRequirements(skill)
  const description = skill.description || plainTextExcerpt(skill.content, 180)
  const scopeLabel = (skill.scope || 'global') === 'agent' ? `${scopedAgents.length || skill.agentIds?.length || 0} ${t('agent')}${(scopedAgents.length || skill.agentIds?.length || 0) === 1 ? '' : 's'}` : t('global')

  return (
    <div className="group rounded-[18px] border border-white/[0.06] bg-surface p-4 text-left transition-all hover:border-white/[0.12] hover:bg-surface-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-display text-[16px] font-600 text-text">{skill.name}</div>
          <div className="mt-1 text-[11px] text-text-3/60">
            {skill.filename} | {t('updated')} {formatTimestamp(skill.updatedAt || skill.createdAt)}
          </div>
        </div>
        <MiniBadge>{scopeLabel}</MiniBadge>
      </div>

      <p className="mt-3 line-clamp-3 text-[13px] leading-[1.7] text-text-3/75">
        {description || t('skillCardDesc')}
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        {skill.version ? <MiniBadge>v{skill.version}</MiniBadge> : null}
        {requirementTotal > 0 ? <MiniBadge>{requirementTotal} {t('requirements')}</MiniBadge> : null}
        {skill.security ? <MiniBadge tone={securityTone(skill.security.level)}>{skill.security.level} {t('risk')}</MiniBadge> : null}
      </div>

      {(skill.tags?.length || skill.toolNames?.length || skill.capabilities?.length) ? (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {[...(skill.tags || []).slice(0, 3), ...(skill.toolNames || []).slice(0, 2)].slice(0, 5).map((item) => (
            <span key={`${skill.id}-${item}`} className="rounded-full bg-white/[0.05] px-2 py-1 text-[10px] font-700 text-text-3/65">
              {item}
            </span>
          ))}
        </div>
      ) : null}

      {scopedAgents.length > 0 ? (
        <div className="mt-4 flex items-center gap-2">
          <div className="flex items-center -space-x-2">
            {scopedAgents.slice(0, 5).map((agent) => (
              <AgentAvatar
                key={agent.id}
                seed={agent.avatarSeed}
                avatarUrl={agent.avatarUrl}
                name={agent.name}
                size={18}
                className="ring-2 ring-surface"
              />
            ))}
          </div>
          {scopedAgents.length > 5 ? (
            <span className="text-[10px] font-600 text-text-3/60">+{scopedAgents.length - 5} {t('more')}</span>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={onOpen} className={secondaryButtonClassName}>
          {t('details')}
          <ArrowRightIcon />
        </button>
        <button type="button" onClick={onEdit} className={ghostButtonClassName}>
          {t('edit')}
          <EditIcon />
        </button>
      </div>
    </div>
  )
}

function HubSkillCard({
  skill,
  installed,
  busy,
  onOpen,
  onInstall,
}: {
  skill: ClawHubSkill
  installed: boolean
  busy: boolean
  onOpen: () => void
  onInstall: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="rounded-[18px] border border-white/[0.06] bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-display text-[16px] font-600 text-text">
            {skill.name}
          </div>
          <div className="mt-1 text-[11px] text-text-3/60">
            {t('by')} {skill.author} | v{skill.version}
            {skill.updatedAt ? ` | ${t('updated')} ${formatTimestamp(skill.updatedAt)}` : ''}
          </div>
        </div>
        <button
          type="button"
          disabled={installed || busy}
          onClick={onInstall}
          className={installed ? disabledButtonClassName : primaryButtonClassName}
        >
          {installed ? t('installed') : busy ? t('installing') : t('install')}
        </button>
      </div>

      <p className="mt-3 line-clamp-3 text-[13px] leading-[1.7] text-text-3/75">
        {skill.description || t('hubCardDesc')}
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <MiniBadge>{skill.downloads.toLocaleString()} {t('installs')}</MiniBadge>
        {typeof skill.stars === 'number' && skill.stars > 0 ? <MiniBadge>{skill.stars.toLocaleString()} {t('stars')}</MiniBadge> : null}
        {skill.tags.slice(0, 3).map((tag) => (
          <MiniBadge key={`${skill.id}-${tag}`}>{tag}</MiniBadge>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={onOpen} className={secondaryButtonClassName}>
          {t('details')}
          <ArrowRightIcon />
        </button>
        <a href={skill.url} target="_blank" rel="noreferrer" className={ghostButtonClassName}>
          {t('openListing')}
          <ExternalLinkIcon />
        </a>
      </div>
    </div>
  )
}

function MetadataGrid({ skill }: { skill: Partial<Skill> }) {
  const { t } = useTranslation()
  return (
    <div className="grid gap-2">
      <MetadataRow label={t('format')} value={skill.sourceFormat === 'openclaw' ? 'OpenClaw' : t('plainMarkdown')} />
      {skill.version ? <MetadataRow label={t('version')} value={skill.version} /> : null}
      {skill.author ? <MetadataRow label={t('author')} value={skill.author} /> : null}
      {skill.homepage ? <MetadataRow label={t('homepage')} value={skill.homepage} href={skill.homepage} /> : null}
      {skill.sourceUrl ? <MetadataRow label={t('sourceFile')} value={skill.sourceUrl} href={skill.sourceUrl} /> : null}
      {skill.primaryEnv ? <MetadataRow label={t('primaryEnv')} value={skill.primaryEnv} /> : null}
      {skill.skillKey ? <MetadataRow label={t('skillKey')} value={skill.skillKey} /> : null}
      {skill.toolNames?.length ? <MetadataRow label={t('tools')} value={skill.toolNames.join(', ')} /> : null}
      {skill.capabilities?.length ? <MetadataRow label={t('capabilities')} value={skill.capabilities.join(', ')} /> : null}
      {skill.invocation?.userInvocable ? <MetadataRow label={t('invocation')} value={t('userInvocable')} /> : null}
      {skill.commandDispatch ? <MetadataRow label={t('dispatch')} value={`${skill.commandDispatch.kind}:${skill.commandDispatch.toolName}`} /> : null}
      {skill.tags?.length ? <MetadataRow label={t('tags')} value={skill.tags.join(', ')} /> : null}
    </div>
  )
}

function SetupOverview({ skill }: { skill: Partial<Skill> }) {
  const { t } = useTranslation()
  const requirements = skill.skillRequirements
  const installOptions = skill.installOptions || []
  const security = skill.security

  return (
    <div className="space-y-3">
      {requirements?.bins?.length ? <MetadataRow label={t('bins')} value={requirements.bins.join(', ')} /> : null}
      {requirements?.env?.length ? <MetadataRow label={t('envVars')} value={requirements.env.join(', ')} /> : null}
      {requirements?.config?.length ? <MetadataRow label={t('config')} value={requirements.config.join(', ')} /> : null}
      {skill.detectedEnvVars?.length ? <MetadataRow label={t('detectedEnvVars')} value={skill.detectedEnvVars.join(', ')} /> : null}
      {installOptions.length ? (
        <MetadataRow
          label={t('installOptions')}
          value={installOptions.map((option) => option.label).join(', ')}
        />
      ) : null}
      {security ? (
        <div className="rounded-[14px] border border-white/[0.06] bg-bg/45 p-3">
          <div className="text-[11px] font-700 uppercase tracking-[0.14em] text-text-3/65">
            {t('security')}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <MiniBadge tone={securityTone(security.level)}>{security.level} {t('risk')}</MiniBadge>
          </div>
          {security.notes.length ? (
            <ul className="mt-3 space-y-1 text-[12px] leading-[1.6] text-text-3/75">
              {security.notes.slice(0, 5).map((note) => (
                <li key={note}>- {note}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <MutedNote>{t('noRequirementsDeclared')}</MutedNote>
      )}
    </div>
  )
}

function MarkdownPreview({ content }: { content: string }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const previewContent = expanded ? content : truncateText(content, 5000)

  return (
    <div className="space-y-3">
      <div className="rounded-[16px] border border-white/[0.06] bg-bg/55 p-4">
        <div className="msg-content text-[14px] leading-[1.7] text-text">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={{
              pre({ children }) {
                return <pre>{children}</pre>
              },
              code({ className, children }) {
                const isBlock = className?.startsWith('language-') || className?.startsWith('hljs')
                if (isBlock) {
                  return <CodeBlock className={className}>{children}</CodeBlock>
                }
                return <code className={className}>{children}</code>
              },
            }}
          >
            {previewContent}
          </ReactMarkdown>
        </div>
      </div>
      {content.length > 5000 ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="cursor-pointer rounded-full border border-white/[0.08] px-3 py-1 text-[11px] font-600 text-text-3/80 transition-colors hover:border-white/[0.14] hover:text-text"
        >
          {expanded ? t('showShorterPreview') : t('showFullSkill')}
        </button>
      ) : null}
    </div>
  )
}

function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-white/[0.08] px-3 py-1.5 text-[12px] font-600 text-text-3/80 transition-colors hover:border-white/[0.14] hover:text-text"
    >
      <span aria-hidden="true">&lt;-</span>
      {label}
    </button>
  )
}

function TabButton({
  active,
  count,
  onClick,
  children,
}: {
  active: boolean
  count?: number
  onClick: () => void
  children: React.ReactNode
}) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative cursor-pointer px-3 py-2 text-[12px] font-700 transition-colors ${
        active ? 'text-accent-bright' : 'text-text-3/65 hover:text-text'
      }`}
    >
      <span className="flex items-center gap-1.5">
        {children}
        {typeof count === 'number' ? <MiniBadge tone={active ? 'accent' : 'neutral'}>{count}</MiniBadge> : null}
      </span>
      {active ? <span className="absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-accent-bright" /> : null}
    </button>
  )
}

function SearchField({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
}) {
  return (
    <label className="relative block">
      <svg className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-3/45" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="w-full rounded-[14px] border border-white/[0.08] bg-bg/65 py-3 pl-10 pr-4 text-[13px] text-text outline-none transition-colors placeholder:text-text-3/45 focus:border-accent-bright/40"
        style={{ fontFamily: 'inherit' }}
      />
    </label>
  )
}

function FilterRow({
  label,
  active,
  items,
  onToggle,
  onClear,
}: {
  label: string
  active: string | null
  items: string[]
  onToggle: (value: string) => void
  onClear: () => void
}) {
  if (items.length === 0) return null

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <span className="text-[11px] font-700 uppercase tracking-[0.14em] text-text-3/60">{label}</span>
      <button type="button" onClick={onClear} className={active ? activeChipClassName : chipClassName}>
        {t('all')}
      </button>
      {items.map((item) => (
        <button
          key={item}
          type="button"
          onClick={() => onToggle(item)}
          className={active === item ? activeChipClassName : chipClassName}
        >
          {item}
        </button>
      ))}
    </div>
  )
}

function QuickStatPill({ label, value, muted = false }: { label: string; value: number; muted?: boolean }) {
  return (
    <div className={`rounded-full border px-3.5 py-2 ${muted ? 'border-white/[0.08] bg-white/[0.03]' : 'border-white/[0.1] bg-black/10'}`}>
      <div className="flex items-center gap-2">
        <span className="text-[14px] font-700 text-text">{value}</span>
        <span className="text-[11px] font-600 text-text-3/70">{label}</span>
      </div>
    </div>
  )
}

function ActionButton({
  label,
  tone,
  disabled,
  onClick,
}: {
  label: string
  tone: 'primary' | 'secondary' | 'ghost' | 'danger'
  disabled?: boolean
  onClick: () => void
}) {
  const className = tone === 'primary'
    ? primaryButtonClassName
    : tone === 'secondary'
      ? secondaryButtonClassName
      : tone === 'danger'
        ? dangerButtonClassName
        : ghostButtonClassName

  return (
    <button type="button" onClick={onClick} disabled={disabled} className={className}>
      {label}
    </button>
  )
}

function ActionAnchor({
  label,
  href,
  tone,
}: {
  label: string
  href: string
  tone: 'secondary' | 'ghost'
}) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={tone === 'secondary' ? secondaryButtonClassName : ghostButtonClassName}>
      {label}
    </a>
  )
}

function DetailCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-[18px] border border-white/[0.08] bg-bg/45 p-4">
      <div className="text-[11px] font-700 uppercase tracking-[0.14em] text-text-3/65">{title}</div>
      <p className="mt-2 whitespace-pre-line text-[13px] leading-[1.7] text-text-2/80">{body}</p>
    </div>
  )
}

function SectionHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-4">
      <div className="text-[11px] font-700 uppercase tracking-[0.14em] text-text-3/65">{title}</div>
      <p className="mt-1 text-[13px] text-text-3/75">{subtitle}</p>
    </div>
  )
}

function MetadataRow({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="rounded-[14px] border border-white/[0.06] bg-bg/45 px-3 py-2.5">
      <div className="text-[10px] font-700 uppercase tracking-[0.12em] text-text-3/60">{label}</div>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" className="mt-1 block cursor-pointer break-words text-[12px] leading-[1.6] text-accent-bright hover:underline">
          {value}
        </a>
      ) : (
        <div className="mt-1 break-words text-[12px] leading-[1.6] text-text-2/80">{value}</div>
      )}
    </div>
  )
}

function MiniBadge({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode
  tone?: 'neutral' | 'accent' | 'warning' | 'success' | 'danger'
}) {
  const className = tone === 'accent'
    ? 'border-accent-bright/20 bg-accent-soft text-accent-bright'
    : tone === 'warning'
      ? 'border-amber-500/20 bg-amber-500/10 text-amber-300'
      : tone === 'success'
        ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300'
        : tone === 'danger'
          ? 'border-red-500/20 bg-red-500/10 text-red-300'
          : 'border-white/[0.08] bg-white/[0.04] text-text-3/75'

  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[10px] font-700 uppercase tracking-[0.08em] ${className}`}>
      {children}
    </span>
  )
}

function EmptyState({
  title,
  body,
  actionLabel,
  onAction,
  secondaryLabel,
  onSecondaryAction,
}: {
  title: string
  body: string
  actionLabel: string
  onAction: () => void
  secondaryLabel?: string
  onSecondaryAction?: () => void
}) {
  return (
    <div className="rounded-[24px] border border-dashed border-white/[0.1] bg-surface/50 px-6 py-12 text-center">
      <div className="mx-auto max-w-xl">
        <h3 className="font-display text-[22px] font-700 tracking-[-0.03em] text-text">{title}</h3>
        <p className="mt-2 text-[13px] leading-[1.7] text-text-3/75">{body}</p>
      </div>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <button type="button" onClick={onAction} className={primaryButtonClassName}>
          {actionLabel}
        </button>
        {secondaryLabel && onSecondaryAction ? (
          <button type="button" onClick={onSecondaryAction} className={secondaryButtonClassName}>
            {secondaryLabel}
          </button>
        ) : null}
      </div>
    </div>
  )
}

function MutedNote({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-[16px] border border-white/[0.06] bg-bg/45 px-4 py-4 text-[13px] leading-[1.7] text-text-3/75 ${className}`}>
      {children}
    </div>
  )
}

function ArrowRightIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  )
}

function ExternalLinkIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 5h5v5" />
      <path d="M10 14 19 5" />
      <path d="M19 14v5H5V5h5" />
    </svg>
  )
}

function EditIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
    </svg>
  )
}

function countRequirements(skill: Partial<Skill>) {
  return (skill.skillRequirements?.env?.length || 0)
    + (skill.skillRequirements?.bins?.length || 0)
    + (skill.skillRequirements?.config?.length || 0)
}

function buildCapabilitySummary(skill: Partial<Skill>) {
  const tools = skill.toolNames || []
  const capabilities = skill.capabilities || []
  if (!tools.length && !capabilities.length && !skill.commandDispatch) {
    return 'No explicit tools or capabilities were declared.'
  }

  const lines: string[] = []
  if (tools.length) lines.push(`Tools: ${tools.join(', ')}`)
  if (capabilities.length) lines.push(`Capabilities: ${capabilities.join(', ')}`)
  if (skill.commandDispatch) lines.push(`Dispatches through ${skill.commandDispatch.toolName}`)
  return lines.join('\n')
}

function buildSetupSummary(skill: Partial<Skill>) {
  const parts: string[] = []
  if (skill.skillRequirements?.env?.length) parts.push(`${skill.skillRequirements.env.length} env vars`)
  if (skill.skillRequirements?.bins?.length) parts.push(`${skill.skillRequirements.bins.length} binaries`)
  if (skill.skillRequirements?.config?.length) parts.push(`${skill.skillRequirements.config.length} config entries`)
  if (skill.security) parts.push(`${skill.security.level} risk`)
  return parts.length ? parts.join(' | ') : 'No setup requirements declared.'
}

function securityTone(level: Skill['security'] extends { level: infer L } ? L : string) {
  if (level === 'high') return 'danger' as const
  if (level === 'medium') return 'warning' as const
  return 'success' as const
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

  return truncateText(text, maxLength)
}

function truncateText(value: string, maxLength: number) {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength).trimEnd()}...`
}

function sortTagsByFrequency(tags: string[]) {
  const counts = new Map<string, number>()
  for (const tag of tags) {
    counts.set(tag, (counts.get(tag) || 0) + 1)
  }
  return dedup(tags).sort((left, right) => {
    const byCount = (counts.get(right) || 0) - (counts.get(left) || 0)
    return byCount !== 0 ? byCount : left.localeCompare(right)
  })
}

function formatTimestamp(timestamp: number) {
  const diff = timestamp - Date.now()
  const abs = Math.abs(diff)
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour

  if (abs < minute) return 'just now'
  if (abs < hour) return rtf.format(Math.round(diff / minute), 'minute')
  if (abs < day) return rtf.format(Math.round(diff / hour), 'hour')
  if (abs < day * 30) return rtf.format(Math.round(diff / day), 'day')
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(timestamp)
}

function extractClawHubSlug(value: string | null | undefined) {
  if (!value) return null
  try {
    const parsed = new URL(value)
    const parts = parsed.pathname.split('/').filter(Boolean)
    if (parts[0] !== 'skills' || !parts[1]) return null
    return parts[1]
  } catch {
    return null
  }
}

function dedupeHubSkills(skills: ClawHubSkill[]) {
  const seen = new Set<string>()
  return skills.filter((skill) => {
    if (seen.has(skill.id)) return false
    seen.add(skill.id)
    return true
  })
}

const selectClassName = 'cursor-pointer rounded-[14px] border border-white/[0.08] bg-bg/65 px-3 py-3 text-[12px] text-text outline-none transition-colors focus:border-accent-bright/40'
const chipClassName = 'cursor-pointer rounded-full border border-white/[0.08] px-3 py-1 text-[11px] font-600 text-text-3/75 transition-colors hover:border-white/[0.14] hover:text-text'
const activeChipClassName = 'cursor-pointer rounded-full border border-accent-bright/20 bg-accent-soft px-3 py-1 text-[11px] font-600 text-accent-bright transition-colors'
const primaryButtonClassName = 'inline-flex cursor-pointer items-center gap-1.5 rounded-[12px] border border-accent-bright/20 bg-accent-soft px-3.5 py-2 text-[12px] font-700 text-accent-bright transition-colors hover:bg-accent-soft/80 disabled:cursor-default disabled:opacity-55'
const secondaryButtonClassName = 'inline-flex cursor-pointer items-center gap-1.5 rounded-[12px] border border-white/[0.08] bg-white/[0.02] px-3.5 py-2 text-[12px] font-700 text-text-2/85 transition-colors hover:border-white/[0.14] hover:text-text disabled:cursor-default disabled:opacity-55'
const ghostButtonClassName = 'inline-flex cursor-pointer items-center gap-1.5 rounded-[12px] border border-transparent bg-transparent px-3.5 py-2 text-[12px] font-700 text-text-3/80 transition-colors hover:border-white/[0.1] hover:bg-white/[0.03] hover:text-text'
const dangerButtonClassName = 'inline-flex cursor-pointer items-center gap-1.5 rounded-[12px] border border-red-500/20 bg-red-500/10 px-3.5 py-2 text-[12px] font-700 text-red-300 transition-colors hover:bg-red-500/15 disabled:cursor-default disabled:opacity-55'
const disabledButtonClassName = 'inline-flex items-center gap-1.5 rounded-[12px] border border-white/[0.08] bg-white/[0.04] px-3.5 py-2 text-[12px] font-700 text-text-3/65'
