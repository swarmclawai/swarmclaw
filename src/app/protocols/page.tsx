'use client'

import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAgentsQuery } from '@/features/agents/queries'
import { useChatroomsQuery } from '@/features/chatrooms/queries'
import {
  useCreateProtocolRunMutation,
  useDeleteProtocolTemplateMutation,
  useProtocolRunActionMutation,
  useProtocolRunDetailQuery,
  useProtocolRunsQuery,
  useProtocolTemplatesQuery,
  useUpsertProtocolTemplateMutation,
} from '@/features/protocols/queries'
import { useTasksQuery } from '@/features/tasks/queries'
import { MainContent } from '@/components/layout/main-content'
import { StructuredSessionLauncher } from '@/components/protocols/structured-session-launcher'
import { TemplateGallery } from '@/components/protocols/builder/template-gallery'
import { GroundingPanel } from '@/components/knowledge/grounding-panel'
import { DEFAULT_BUILDER_ROUTE } from '@/lib/home-launchpad'
import { timeAgo } from '@/lib/time-format'
import type {
  BoardTask,
  Chatroom,
  ProtocolRun,
  ProtocolRunEvent,
  ProtocolStepDefinition,
  ProtocolTemplate,
} from '@/types'

type ProtocolRunDetail = {
  run: ProtocolRun
  template: ProtocolTemplate | null
  transcript: Chatroom | null
  parentChatroom: Chatroom | null
  linkedTask: BoardTask | null
  events: ProtocolRunEvent[]
}

type AgentList = Record<string, { id: string; name: string }>
type RunStatusFilter = 'all' | ProtocolRun['status']

function statusTone(status: ProtocolRun['status']): string {
  if (status === 'completed') return 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20'
  if (status === 'waiting') return 'text-amber-300 bg-amber-500/10 border-amber-500/20'
  if (status === 'paused') return 'text-indigo-300 bg-indigo-500/10 border-indigo-500/20'
  if (status === 'failed') return 'text-red-300 bg-red-500/10 border-red-500/20'
  if (status === 'cancelled' || status === 'archived') return 'text-text-3 bg-white/[0.04] border-white/[0.08]'
  return 'text-sky-300 bg-sky-500/10 border-sky-500/20'
}

type RunActionPayload =
  | { action: 'start' | 'pause' | 'resume' | 'retry_phase' | 'skip_phase' | 'cancel' | 'archive' }
  | { action: 'inject_context'; context: string }

type TemplateDraft = {
  name: string
  description: string
  tags: string
  recommendedOutputs: string
  singleAgentAllowed: boolean
  stepsJson: string
  entryStepId: string
}

const DEFAULT_TEMPLATE_DRAFT: TemplateDraft = {
  name: '',
  description: '',
  tags: '',
  recommendedOutputs: '',
  singleAgentAllowed: true,
  stepsJson: JSON.stringify([
    { id: 'present', kind: 'present', label: 'Open the session', nextStepId: 'summarize' },
    { id: 'summarize', kind: 'summarize', label: 'Summarize the outcome', nextStepId: 'complete' },
    { id: 'complete', kind: 'complete', label: 'Complete the run' },
  ], null, 2),
  entryStepId: 'present',
}

function toTemplateDraft(template: ProtocolTemplate | null): TemplateDraft {
  if (!template) return DEFAULT_TEMPLATE_DRAFT
  return {
    name: template.name,
    description: template.description,
    tags: (template.tags || []).join(', '),
    recommendedOutputs: (template.recommendedOutputs || []).join(', '),
    singleAgentAllowed: template.singleAgentAllowed !== false,
    stepsJson: JSON.stringify(template.steps || [], null, 2),
    entryStepId: template.entryStepId || template.steps?.[0]?.id || '',
  }
}

function parseStepJson(value: string): ProtocolStepDefinition[] {
  let parsed: unknown
  try { parsed = JSON.parse(value) }
  catch { throw new Error('Steps JSON is not valid JSON. Please check the syntax.') }
  if (!Array.isArray(parsed)) throw new Error('Steps JSON must be an array.')
  return parsed as ProtocolStepDefinition[]
}

function stepsForTemplate(template: ProtocolTemplate | null): ProtocolStepDefinition[] {
  return template?.steps || []
}

function stepsForRun(run: ProtocolRun | null | undefined): ProtocolStepDefinition[] {
  return run?.steps || []
}

function currentStepIndex(run: ProtocolRun | null | undefined): number {
  const steps = stepsForRun(run)
  if (!run || steps.length === 0) return 0
  if (!run.currentStepId) return run.status === 'completed' ? steps.length : 0
  const found = steps.findIndex((step) => step.id === run.currentStepId)
  return found === -1 ? 0 : found
}

function currentStepDefinition(run: ProtocolRun | null | undefined): ProtocolStepDefinition | null {
  const steps = stepsForRun(run)
  const index = currentStepIndex(run)
  if (!run || steps.length === 0 || index >= steps.length) return null
  return steps[index] || null
}

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

export default function ProtocolsPage() {
  const { t } = useTranslation()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [actionPending, setActionPending] = useState<string | null>(null)
  const [templatePending, setTemplatePending] = useState<string | null>(null)
  const [templateEditorOpen, setTemplateEditorOpen] = useState(false)
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null)
  const [templateDraft, setTemplateDraft] = useState<TemplateDraft>(DEFAULT_TEMPLATE_DRAFT)
  const [contextDraft, setContextDraft] = useState('')
  const [launcherOpen, setLauncherOpen] = useState(false)
  const [runSearch, setRunSearch] = useState('')
  const [runStatusFilter, setRunStatusFilter] = useState<RunStatusFilter>('all')
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState({
    title: '',
    templateId: 'facilitated_discussion',
    goal: '',
    kickoffMessage: '',
    roundLimit: '',
    decisionMode: '',
    facilitatorAgentId: '',
    participantAgentIds: [] as string[],
    parentChatroomId: '',
    taskId: '',
    autoStart: true,
  })
  const requestedRunId = searchParams.get('runId')
  const templatesQuery = useProtocolTemplatesQuery()
  const runsQuery = useProtocolRunsQuery({ limit: 120 })
  const agentsQuery = useAgentsQuery()
  const chatroomsQuery = useChatroomsQuery()
  const tasksQuery = useTasksQuery({ includeArchived: true })
  const detailQuery = useProtocolRunDetailQuery(selectedRunId, { enabled: Boolean(selectedRunId) })
  const createRunMutation = useCreateProtocolRunMutation()
  const runActionMutation = useProtocolRunActionMutation()
  const upsertTemplateMutation = useUpsertProtocolTemplateMutation()
  const deleteTemplateMutation = useDeleteProtocolTemplateMutation()
  const templates = useMemo(() => templatesQuery.data ?? [], [templatesQuery.data])
  const runs = useMemo(() => runsQuery.data ?? [], [runsQuery.data])
  const detail = detailQuery.data ?? null
  const agents = agentsQuery.data ?? {}
  const chatrooms = chatroomsQuery.data ?? {}
  const tasks = tasksQuery.data ?? {}
  const loading = (
    templatesQuery.isLoading
    || runsQuery.isLoading
    || agentsQuery.isLoading
    || chatroomsQuery.isLoading
    || tasksQuery.isLoading
  )
  const detailLoading = detailQuery.isLoading || detailQuery.isFetching
  const queryError = [
    templatesQuery.error,
    runsQuery.error,
    agentsQuery.error,
    chatroomsQuery.error,
    tasksQuery.error,
    detailQuery.error,
  ].find(Boolean)
  const resolvedError = error || (queryError instanceof Error ? queryError.message : null)

  // Apply URL-requested run selection separately so WS refreshes don't snap back
  useEffect(() => {
    if (requestedRunId) setSelectedRunId(requestedRunId)
  }, [requestedRunId])

  useEffect(() => {
    setSelectedRunId((current) => {
      if (current && runs.some((run) => run.id === current)) return current
      return runs[0]?.id || null
    })
  }, [runs])

  const selectedTemplate = useMemo(() => templates.find((template) => template.id === form.templateId) || null, [form.templateId, templates])
  const customTemplates = useMemo(() => templates.filter((template) => !template.builtIn), [templates])
  const builtInTemplates = useMemo(() => templates.filter((template) => template.builtIn), [templates])
  const artifactCitationMap = useMemo(() => {
    const map = new Map<string, ProtocolRunEvent['citations']>()
    for (const event of detail?.events || []) {
      if (!event.artifactId || !event.citations?.length) continue
      map.set(event.artifactId, event.citations)
    }
    return map
  }, [detail?.events])
  const filteredRuns = useMemo(() => {
    const search = runSearch.trim().toLowerCase()
    return runs.filter((run) => {
      if (runStatusFilter !== 'all' && run.status !== runStatusFilter) return false
      if (!search) return true
      return [run.title, run.templateName, run.summary, run.waitingReason]
        .some((value) => typeof value === 'string' && value.toLowerCase().includes(search))
    })
  }, [runSearch, runStatusFilter, runs])

  const handleCreate = useCallback(async () => {
    if (!form.title.trim()) {
      setError(t('titleRequired'))
      return
    }
    if (form.participantAgentIds.length === 0) {
      setError(t('selectParticipant'))
      return
    }
    try {
      const run = await createRunMutation.mutateAsync({
        title: form.title.trim(),
        templateId: form.templateId,
        participantAgentIds: form.participantAgentIds,
        facilitatorAgentId: form.facilitatorAgentId || null,
        parentChatroomId: form.parentChatroomId || null,
        taskId: form.taskId || null,
        autoStart: form.autoStart,
        config: {
          goal: form.goal || null,
          kickoffMessage: form.kickoffMessage || null,
          roundLimit: form.roundLimit ? Number.parseInt(form.roundLimit, 10) : null,
          decisionMode: form.decisionMode || null,
        },
      })
      setForm((current) => ({
        ...current,
        title: '',
        goal: '',
        kickoffMessage: '',
        roundLimit: '',
        decisionMode: '',
      }))
      setSelectedRunId(run.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('createRunFailed'))
    }
  }, [createRunMutation, form, t])

  const handleAction = useCallback(async (payload: RunActionPayload) => {
    if (!detail?.run.id) return
    setActionPending(payload.action)
    try {
      await runActionMutation.mutateAsync({ runId: detail.run.id, payload })
      if (payload.action === 'inject_context') setContextDraft('')
    } catch (err) {
      setError(err instanceof Error ? err.message : t('updateRunFailed'))
    } finally {
      setActionPending(null)
    }
  }, [detail, runActionMutation, t])

  const handleBranchAction = useCallback(async (runId: string, payload: RunActionPayload) => {
    setActionPending(`${payload.action}:${runId}`)
    try {
      await runActionMutation.mutateAsync({ runId, payload })
    } catch (err) {
      setError(err instanceof Error ? err.message : t('updateBranchFailed'))
    } finally {
      setActionPending(null)
    }
  }, [runActionMutation, t])

  const openTemplateEditor = useCallback((template: ProtocolTemplate | null = null) => {
    setEditingTemplateId(template?.builtIn ? null : template?.id || null)
    setTemplateDraft(toTemplateDraft(template && !template.builtIn ? template : null))
    setTemplateEditorOpen(true)
  }, [])

  const handleSaveTemplate = useCallback(async () => {
    try {
      const steps = parseStepJson(templateDraft.stepsJson)
      const payload = {
        name: templateDraft.name.trim(),
        description: templateDraft.description.trim(),
        tags: splitCsv(templateDraft.tags),
        recommendedOutputs: splitCsv(templateDraft.recommendedOutputs),
        singleAgentAllowed: templateDraft.singleAgentAllowed,
        steps,
        entryStepId: templateDraft.entryStepId.trim() || steps[0]?.id || null,
      }
      if (!payload.name || !payload.description || payload.steps.length === 0) {
        setError(t('templateValidationError'))
        return
      }
      if (payload.entryStepId && !payload.steps.some((step) => step.id === payload.entryStepId)) {
        setError(t('entryStepValidationError'))
        return
      }
      setTemplatePending(editingTemplateId ? 'save-edit' : 'save-new')
      const created = await upsertTemplateMutation.mutateAsync({
        templateId: editingTemplateId,
        payload,
      })
      if (!editingTemplateId) {
        setForm((current) => ({ ...current, templateId: created.id }))
      }
      setTemplateEditorOpen(false)
      setEditingTemplateId(null)
      setTemplateDraft(DEFAULT_TEMPLATE_DRAFT)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('saveTemplateFailed'))
    } finally {
      setTemplatePending(null)
    }
  }, [editingTemplateId, templateDraft, upsertTemplateMutation, t])

  const handleDeleteTemplate = useCallback(async (templateId: string) => {
    setTemplatePending(`delete:${templateId}`)
    try {
      await deleteTemplateMutation.mutateAsync(templateId)
      setTemplateEditorOpen(false)
      setEditingTemplateId(null)
      setTemplateDraft(DEFAULT_TEMPLATE_DRAFT)
      setForm((current) => ({
        ...current,
        templateId: current.templateId === templateId ? 'facilitated_discussion' : current.templateId,
      }))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('deleteTemplateFailed'))
    } finally {
      setTemplatePending(null)
    }
  }, [deleteTemplateMutation, t])

  const handleSelectRun = useCallback((runId: string) => {
    setSelectedRunId(runId)
    router.replace(`/protocols?runId=${encodeURIComponent(runId)}`)
  }, [router])

  return (
    <MainContent>
      <div className="flex-1 min-h-0 overflow-y-auto bg-bg px-4 py-5 md:px-6 md:py-6">
        <div className="mx-auto max-w-[1680px] space-y-5">
          <section className="rounded-[24px] border border-white/[0.06] bg-white/[0.03] p-5 md:p-6">
            <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
              <div className="max-w-[780px]">
                <div className="inline-flex rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1 text-[11px] font-700 uppercase tracking-[0.18em] text-text-3/70">
                  {t('structuredSessions')}
                </div>
                <h1 className="mt-4 font-display text-[34px] font-700 tracking-[-0.03em] text-text">{t('boundedCollaborationRuns')}</h1>
                <p className="mt-3 max-w-[720px] text-[15px] leading-relaxed text-text-3/72">
                  {t('protocolsDescription')}
                </p>
              </div>
              <div className="w-full max-w-[520px] rounded-[20px] border border-white/[0.06] bg-surface/70 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-[11px] font-700 uppercase tracking-[0.12em] text-text-3/55">{t('launchAndTemplates')}</div>
                    <div className="mt-1 text-[13px] leading-relaxed text-text-3/68">
                      {t('launchAndTemplatesDesc')}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setLauncherOpen(true)}
                      className="rounded-[10px] bg-accent-bright px-3 py-2 text-[12px] font-700 text-black transition-all hover:opacity-90 cursor-pointer"
                    >
                      {t('startStructuredSession')}
                    </button>
                    <button
                      type="button"
                      onClick={() => openTemplateEditor()}
                      className="rounded-[10px] border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-[12px] font-700 text-text-2 transition-all hover:bg-white/[0.08] cursor-pointer"
                    >
                      {t('newTemplate')}
                    </button>
                    <button
                      type="button"
                      onClick={() => router.push(DEFAULT_BUILDER_ROUTE)}
                      className="rounded-[10px] border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-[12px] font-700 text-text-2 transition-all hover:bg-white/[0.08] cursor-pointer"
                    >
                      {t('openVisualBuilder')}
                    </button>
                  </div>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  <div className="rounded-[16px] border border-white/[0.06] bg-white/[0.03] p-4">
                    <div className="text-[11px] font-700 uppercase tracking-[0.12em] text-text-3/55">{t('builtInTemplates')}</div>
                    <div className="mt-2 text-[28px] font-700 tracking-[-0.03em] text-text">{builtInTemplates.length}</div>
                    <div className="mt-2 text-[12px] leading-relaxed text-text-3/68">
                      {t('builtInTemplatesDesc')}
                    </div>
                  </div>
                  <div className="rounded-[16px] border border-white/[0.06] bg-white/[0.03] p-4">
                    <div className="text-[11px] font-700 uppercase tracking-[0.12em] text-text-3/55">{t('customTemplates')}</div>
                    <div className="mt-2 text-[28px] font-700 tracking-[-0.03em] text-text">{customTemplates.length}</div>
                    <div className="mt-2 text-[12px] leading-relaxed text-text-3/68">
                      {t('customTemplatesDesc')}
                    </div>
                  </div>
                  <div className="rounded-[16px] border border-white/[0.06] bg-white/[0.03] p-4">
                    <div className="text-[11px] font-700 uppercase tracking-[0.12em] text-text-3/55">{t('recentRuns')}</div>
                    <div className="mt-2 text-[28px] font-700 tracking-[-0.03em] text-text">{runs.length}</div>
                    <div className="mt-2 text-[12px] leading-relaxed text-text-3/68">
                      {t('recentRunsDesc')}
                    </div>
                  </div>
                </div>

                <div className="mt-4 rounded-[16px] border border-white/[0.06] bg-white/[0.03] p-4">
                  <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                    <div className="max-w-[720px]">
                      <div className="text-[11px] font-700 uppercase tracking-[0.12em] text-text-3/55">{t('visualWorkflowTemplates')}</div>
                      <div className="mt-2 text-[15px] font-700 text-text">{t('visualWorkflowTemplatesTitle')}</div>
                      <div className="mt-2 text-[13px] leading-relaxed text-text-3/72">
                        {t('visualWorkflowTemplatesDesc')}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => router.push(DEFAULT_BUILDER_ROUTE)}
                      className="rounded-[10px] bg-accent-bright px-3 py-2 text-[12px] font-700 text-black transition-all hover:opacity-90 cursor-pointer"
                    >
                      {t('openBuilder')}
                    </button>
                  </div>
                  <div className="mt-4">
                    <TemplateGallery templates={templates} />
                  </div>
                </div>

                <details className="mt-4 rounded-[16px] border border-white/[0.06] bg-white/[0.03] p-4">
                  <summary className="cursor-pointer list-none text-[11px] font-700 uppercase tracking-[0.12em] text-text-3/55">
                    {t('advancedManualRunBuilder')}
                  </summary>
                  <div className="mt-4 space-y-4">
                    <div className="grid gap-3 md:grid-cols-2">
                      <input
                        value={form.title}
                        onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
                        placeholder={t('title')}
                        className="rounded-[12px] border border-white/[0.06] bg-white/[0.04] px-3 py-2.5 text-[14px] text-text outline-none placeholder:text-text-3/35 md:col-span-2"
                      />
                      <select
                        value={form.templateId}
                        onChange={(event) => setForm((current) => ({ ...current, templateId: event.target.value }))}
                        className="rounded-[12px] border border-white/[0.06] bg-white/[0.04] px-3 py-2.5 text-[14px] text-text outline-none"
                      >
                        {templates.map((template) => (
                          <option key={template.id} value={template.id}>{template.name}</option>
                        ))}
                      </select>
                      <select
                        value={form.facilitatorAgentId}
                        onChange={(event) => setForm((current) => ({ ...current, facilitatorAgentId: event.target.value }))}
                        className="rounded-[12px] border border-white/[0.06] bg-white/[0.04] px-3 py-2.5 text-[14px] text-text outline-none"
                      >
                        <option value="">{t('facilitatorFirstParticipant')}</option>
                        {Object.values(agents).map((agent) => (
                          <option key={agent.id} value={agent.id}>{agent.name}</option>
                        ))}
                      </select>
                      <input
                        value={form.goal}
                        onChange={(event) => setForm((current) => ({ ...current, goal: event.target.value }))}
                        placeholder={t('objectiveOrGoal')}
                        className="rounded-[12px] border border-white/[0.06] bg-white/[0.04] px-3 py-2.5 text-[14px] text-text outline-none placeholder:text-text-3/35 md:col-span-2"
                      />
                      <textarea
                        value={form.kickoffMessage}
                        onChange={(event) => setForm((current) => ({ ...current, kickoffMessage: event.target.value }))}
                        placeholder={t('optionalKickoffContext')}
                        rows={3}
                        className="rounded-[12px] border border-white/[0.06] bg-white/[0.04] px-3 py-2.5 text-[14px] text-text outline-none placeholder:text-text-3/35 md:col-span-2"
                      />
                      <select
                        value={form.parentChatroomId}
                        onChange={(event) => setForm((current) => ({ ...current, parentChatroomId: event.target.value }))}
                        className="rounded-[12px] border border-white/[0.06] bg-white/[0.04] px-3 py-2.5 text-[14px] text-text outline-none"
                      >
                        <option value="">{t('noParentChatroom')}</option>
                        {Object.values(chatrooms).map((chatroom) => (
                          <option key={chatroom.id} value={chatroom.id}>{chatroom.name}</option>
                        ))}
                      </select>
                      <select
                        value={form.taskId}
                        onChange={(event) => setForm((current) => ({ ...current, taskId: event.target.value }))}
                        className="rounded-[12px] border border-white/[0.06] bg-white/[0.04] px-3 py-2.5 text-[14px] text-text outline-none"
                      >
                        <option value="">{t('noLinkedTask')}</option>
                        {Object.values(tasks).map((task) => (
                          <option key={task.id} value={task.id}>{task.title}</option>
                        ))}
                      </select>
                      <input
                        value={form.roundLimit}
                        onChange={(event) => setForm((current) => ({ ...current, roundLimit: event.target.value }))}
                        placeholder={t('roundLimit')}
                        className="rounded-[12px] border border-white/[0.06] bg-white/[0.04] px-3 py-2.5 text-[14px] text-text outline-none placeholder:text-text-3/35"
                      />
                      <input
                        value={form.decisionMode}
                        onChange={(event) => setForm((current) => ({ ...current, decisionMode: event.target.value }))}
                        placeholder={t('decisionMode')}
                        className="rounded-[12px] border border-white/[0.06] bg-white/[0.04] px-3 py-2.5 text-[14px] text-text outline-none placeholder:text-text-3/35"
                      />
                    </div>

                    <div>
                      <div className="text-[11px] font-700 uppercase tracking-[0.12em] text-text-3/55">{t('participants')}</div>
                      <div className="mt-2 flex max-h-[180px] flex-wrap gap-2 overflow-y-auto rounded-[14px] border border-white/[0.06] bg-white/[0.03] p-3">
                        {Object.values(agents).map((agent) => {
                          const active = form.participantAgentIds.includes(agent.id)
                          return (
                            <button
                              key={agent.id}
                              type="button"
                              onClick={() => setForm((current) => ({
                                ...current,
                                participantAgentIds: active
                                  ? current.participantAgentIds.filter((id) => id !== agent.id)
                                  : [...current.participantAgentIds, agent.id],
                              }))}
                              className={`rounded-full border px-3 py-1.5 text-[12px] font-600 transition-all cursor-pointer ${
                                active
                                  ? 'border-accent-bright/30 bg-accent-soft text-accent-bright'
                                  : 'border-white/[0.08] bg-transparent text-text-2 hover:bg-white/[0.04]'
                              }`}
                            >
                              {agent.name}
                            </button>
                          )
                        })}
                      </div>
                    </div>

                    {selectedTemplate && (
                      <div className="rounded-[14px] border border-white/[0.06] bg-white/[0.03] p-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-[12px] font-700 text-text">{selectedTemplate.name}</div>
                          <div className="flex items-center gap-2">
                            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-700 uppercase tracking-[0.12em] ${
                              selectedTemplate.builtIn
                                ? 'border-white/[0.08] bg-white/[0.04] text-text-3/75'
                                : 'border-sky-500/20 bg-sky-500/10 text-sky-200'
                            }`}>
                              {selectedTemplate.builtIn ? t('builtIn') : t('custom')}
                            </span>
                            {!selectedTemplate.builtIn && (
                              <button
                                type="button"
                                onClick={() => openTemplateEditor(selectedTemplate)}
                                className="rounded-[8px] border border-white/[0.08] bg-white/[0.04] px-2.5 py-1 text-[11px] font-700 text-text-2 transition-all hover:bg-white/[0.08] cursor-pointer"
                              >
                                {t('edit')}
                              </button>
                            )}
                          </div>
                        </div>
                        <div className="mt-1 text-[12px] leading-relaxed text-text-3/72">{selectedTemplate.description}</div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {stepsForTemplate(selectedTemplate).map((step) => (
                            <span key={step.id} className="rounded-full border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-[11px] text-text-3">
                              {step.label}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    <label className="flex items-center gap-2 text-[13px] text-text-2">
                      <input
                        type="checkbox"
                        checked={form.autoStart}
                        onChange={(event) => setForm((current) => ({ ...current, autoStart: event.target.checked }))}
                      />
                      {t('startImmediately')}
                    </label>

                    <button
                      type="button"
                      onClick={() => void handleCreate()}
                      className="inline-flex items-center justify-center rounded-[12px] bg-accent-bright px-4 py-2.5 text-[13px] font-700 text-black transition-all hover:opacity-90 cursor-pointer"
                    >
                      {t('createStructuredSession')}
                    </button>
                  </div>
                </details>

                {templateEditorOpen && (
                  <div className="mt-4 rounded-[16px] border border-sky-500/18 bg-sky-500/[0.04] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-[12px] font-700 uppercase tracking-[0.12em] text-sky-200/72">
                          {editingTemplateId ? t('editCustomTemplate') : t('newCustomTemplate')}
                        </div>
                        <div className="mt-1 text-[12px] leading-relaxed text-text-3/72">
                          {t('templateEditorDesc')}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setTemplateEditorOpen(false)
                          setEditingTemplateId(null)
                          setTemplateDraft(DEFAULT_TEMPLATE_DRAFT)
                        }}
                        className="rounded-[8px] border border-white/[0.08] bg-white/[0.04] px-2.5 py-1 text-[11px] font-700 text-text-2 transition-all hover:bg-white/[0.08] cursor-pointer"
                      >
                        {t('close')}
                      </button>
                    </div>
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      <input
                        value={templateDraft.name}
                        onChange={(event) => setTemplateDraft((current) => ({ ...current, name: event.target.value }))}
                        placeholder={t('templateName')}
                        className="rounded-[12px] border border-white/[0.06] bg-black/20 px-3 py-2.5 text-[14px] text-text outline-none placeholder:text-text-3/35"
                      />
                      <label className="flex items-center gap-2 rounded-[12px] border border-white/[0.06] bg-black/20 px-3 py-2.5 text-[13px] text-text-2">
                        <input
                          type="checkbox"
                          checked={templateDraft.singleAgentAllowed}
                          onChange={(event) => setTemplateDraft((current) => ({ ...current, singleAgentAllowed: event.target.checked }))}
                        />
                        {t('allowSingleAgentRuns')}
                      </label>
                      <textarea
                        value={templateDraft.description}
                        onChange={(event) => setTemplateDraft((current) => ({ ...current, description: event.target.value }))}
                        placeholder={t('templateDescription')}
                        rows={3}
                        className="rounded-[12px] border border-white/[0.06] bg-black/20 px-3 py-2.5 text-[14px] text-text outline-none placeholder:text-text-3/35 md:col-span-2"
                      />
                      <input
                        value={templateDraft.tags}
                        onChange={(event) => setTemplateDraft((current) => ({ ...current, tags: event.target.value }))}
                        placeholder={t('tagsCommaSeparated')}
                        className="rounded-[12px] border border-white/[0.06] bg-black/20 px-3 py-2.5 text-[14px] text-text outline-none placeholder:text-text-3/35"
                      />
                      <input
                        value={templateDraft.recommendedOutputs}
                        onChange={(event) => setTemplateDraft((current) => ({ ...current, recommendedOutputs: event.target.value }))}
                        placeholder={t('recommendedOutputsCommaSeparated')}
                        className="rounded-[12px] border border-white/[0.06] bg-black/20 px-3 py-2.5 text-[14px] text-text outline-none placeholder:text-text-3/35"
                      />
                      <input
                        value={templateDraft.entryStepId}
                        onChange={(event) => setTemplateDraft((current) => ({ ...current, entryStepId: event.target.value }))}
                        placeholder={t('entryStepId')}
                        className="rounded-[12px] border border-white/[0.06] bg-black/20 px-3 py-2.5 text-[14px] text-text outline-none placeholder:text-text-3/35 md:col-span-2"
                      />
                      <textarea
                        value={templateDraft.stepsJson}
                        onChange={(event) => setTemplateDraft((current) => ({ ...current, stepsJson: event.target.value }))}
                        rows={10}
                        className="rounded-[12px] border border-white/[0.06] bg-black/35 px-3 py-2.5 font-mono text-[12px] leading-relaxed text-text outline-none md:col-span-2"
                      />
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => void handleSaveTemplate()}
                        className="rounded-[10px] bg-accent-bright px-3 py-2 text-[12px] font-700 text-black transition-all hover:opacity-90 cursor-pointer"
                      >
                        {templatePending === 'save-new' || templatePending === 'save-edit'
                          ? t('saving')
                          : editingTemplateId ? t('saveTemplate') : t('createTemplate')}
                      </button>
                      {editingTemplateId && (
                        <>
                          <button
                            type="button"
                            onClick={() => router.push(`/protocols/builder/${editingTemplateId}`)}
                            className="rounded-[10px] border border-blue-500/20 bg-blue-500/10 px-3 py-2 text-[12px] font-700 text-blue-200 transition-all hover:bg-blue-500/14 cursor-pointer"
                          >
                            {t('visualBuilder')}
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDeleteTemplate(editingTemplateId)}
                            className="rounded-[10px] border border-red-500/20 bg-red-500/10 px-3 py-2 text-[12px] font-700 text-red-200 transition-all hover:bg-red-500/14 cursor-pointer"
                          >
                            {templatePending === `delete:${editingTemplateId}` ? t('deleting') : t('deleteTemplate')}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )}

                {customTemplates.length > 0 && (
                  <div className="mt-4 rounded-[14px] border border-white/[0.06] bg-white/[0.03] p-3">
                    <div className="text-[11px] font-700 uppercase tracking-[0.12em] text-text-3/55">{t('customTemplates')}</div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {customTemplates.map((template) => (
                        <button
                          key={template.id}
                          type="button"
                          onClick={() => openTemplateEditor(template)}
                          className="rounded-full border border-white/[0.08] bg-transparent px-3 py-1.5 text-[11px] font-700 text-text-2 transition-all hover:bg-white/[0.04] cursor-pointer"
                        >
                          {template.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
            {resolvedError && (
              <div className="mt-4 rounded-[14px] border border-red-500/20 bg-red-500/10 px-4 py-3 text-[13px] text-red-200">
                {resolvedError}
              </div>
            )}
          </section>

          <div className="grid min-h-0 gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
            <section className="min-h-0 rounded-[24px] border border-white/[0.06] bg-white/[0.02] p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-[16px] font-700 text-text">{t('runs')}</h2>
                  <span className="text-[12px] text-text-3/60">{t('visibleCount', { count: filteredRuns.length })}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setLauncherOpen(true)}
                  className="rounded-[10px] border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-[11px] font-700 text-text-2 transition-all hover:bg-white/[0.08] cursor-pointer"
                >
                  {t('start')}
                </button>
              </div>
              <div className="mt-4 space-y-3">
                <input
                  value={runSearch}
                  onChange={(event) => setRunSearch(event.target.value)}
                  placeholder={t('searchRunsPlaceholder')}
                  className="w-full rounded-[12px] border border-white/[0.06] bg-white/[0.04] px-3 py-2.5 text-[13px] text-text outline-none placeholder:text-text-3/35"
                />
                <div className="flex flex-wrap gap-2">
                  {(['all', 'draft', 'running', 'waiting', 'paused', 'completed', 'failed'] as RunStatusFilter[]).map((filter) => (
                    <button
                      key={filter}
                      type="button"
                      onClick={() => setRunStatusFilter(filter)}
                      className={`rounded-full border px-2.5 py-1 text-[10px] font-700 uppercase tracking-[0.08em] transition-all cursor-pointer ${
                        runStatusFilter === filter
                          ? 'border-accent-bright/20 bg-accent-soft/45 text-accent-bright'
                          : 'border-white/[0.08] bg-transparent text-text-3/72 hover:bg-white/[0.04]'
                      }`}
                    >
                      {filter === 'all' ? t('all') : t(filter)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="mt-4 max-h-[880px] space-y-2 overflow-y-auto pr-1">
                {loading ? (
                  <div className="text-[13px] text-text-3/65">{t('loadingRuns')}</div>
                ) : filteredRuns.length === 0 ? (
                  <div className="rounded-[16px] border border-white/[0.06] bg-white/[0.03] p-4 text-[13px] text-text-3/65">
                    {t('noRunsMatch')}
                  </div>
                ) : filteredRuns.map((run) => (
                  <button
                    key={run.id}
                    type="button"
                    onClick={() => handleSelectRun(run.id)}
                    className={`w-full rounded-[16px] border px-4 py-3 text-left transition-all cursor-pointer ${
                      selectedRunId === run.id
                        ? 'border-accent-bright/20 bg-accent-soft/45'
                        : 'border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04]'
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-700 text-text">{run.title}</div>
                        <div className="mt-1 text-[11px] text-text-3/72">{run.templateName}</div>
                      </div>
                      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-700 uppercase tracking-[0.12em] ${statusTone(run.status)}`}>
                        {run.status}
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-text-3/65">
                      <span>{t('participantsCount', { count: run.participantAgentIds.length })}</span>
                      <span>{t('stepProgress', { current: Math.min(currentStepIndex(run) + 1, Math.max(stepsForRun(run).length, 1)), total: stepsForRun(run).length })}</span>
                      <span>{timeAgo(run.updatedAt)}</span>
                    </div>
                  </button>
                ))}
              </div>
            </section>

            <section className="min-h-0 rounded-[24px] border border-white/[0.06] bg-white/[0.02] p-4 md:p-5">
              {detailLoading ? (
                <div className="text-[13px] text-text-3/65">{t('loadingRunDetail')}</div>
              ) : !detail ? (
                <div className="rounded-[16px] border border-white/[0.06] bg-white/[0.03] p-4 text-[13px] text-text-3/65">
                  {t('selectRunToInspect')}
                </div>
              ) : (
                <div className="flex min-h-0 flex-col gap-4">
                  <div className="flex flex-col gap-3 rounded-[20px] border border-white/[0.06] bg-white/[0.03] p-4">
                    <div className="flex flex-wrap items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-[12px] font-700 uppercase tracking-[0.12em] text-text-3/55">{t('currentRun')}</div>
                        <h2 className="mt-2 text-[24px] font-700 tracking-[-0.02em] text-text">{detail.run.title}</h2>
                        <div className="mt-2 flex flex-wrap gap-2 text-[12px] text-text-3/68">
                          <span>{detail.run.templateName}</span>
                          <span>•</span>
                          <span>{t(detail.run.sourceRef.kind)}</span>
                          {detail.run.systemOwned && (
                            <>
                              <span>•</span>
                              <span>{t('branchRun')}</span>
                            </>
                          )}
                          <span>•</span>
                          <span>{detail.run.participantAgentIds.map((agentId) => agents[agentId]?.name || agentId).join(', ')}</span>
                        </div>
                      </div>
                      <span className={`rounded-full border px-3 py-1 text-[11px] font-700 uppercase tracking-[0.12em] ${statusTone(detail.run.status)}`}>
                        {detail.run.status}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {detail.transcript?.id && (
                        <button
                          type="button"
                          onClick={() => router.push(`/chatrooms/${encodeURIComponent(detail.transcript?.id || '')}`)}
                          className="rounded-[10px] border border-sky-500/20 bg-sky-500/10 px-3 py-2 text-[12px] font-700 text-sky-100 cursor-pointer"
                        >
                          {detail.run.status === 'running' || detail.run.status === 'waiting' || detail.run.status === 'paused'
                            ? t('watchLiveRoom')
                            : t('openTranscriptRoom')}
                        </button>
                      )}
                      {detail.run.status === 'draft' && (
                        <button type="button" onClick={() => void handleAction({ action: 'start' })} className="rounded-[10px] bg-accent-bright px-3 py-2 text-[12px] font-700 text-black cursor-pointer">
                          {actionPending === 'start' ? t('starting') : t('start')}
                        </button>
                      )}
                      {(detail.run.status === 'waiting' || detail.run.status === 'paused') && (
                        <button type="button" onClick={() => void handleAction({ action: 'resume' })} className="rounded-[10px] bg-accent-bright px-3 py-2 text-[12px] font-700 text-black cursor-pointer">
                          {actionPending === 'resume' ? t('resuming') : t('resume')}
                        </button>
                      )}
                      {detail.run.status !== 'completed' && detail.run.status !== 'cancelled' && detail.run.status !== 'archived' && detail.run.status !== 'paused' && (
                        <button type="button" onClick={() => void handleAction({ action: 'pause' })} className="rounded-[10px] border border-indigo-500/20 bg-indigo-500/10 px-3 py-2 text-[12px] font-700 text-indigo-200 cursor-pointer">
                          {actionPending === 'pause' ? t('pausing') : t('pause')}
                        </button>
                      )}
                      {detail.run.status !== 'completed' && detail.run.status !== 'cancelled' && detail.run.status !== 'archived' && (
                        <button type="button" onClick={() => void handleAction({ action: 'retry_phase' })} className="rounded-[10px] border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-[12px] font-700 text-text-2 cursor-pointer">
                          {actionPending === 'retry_phase' ? t('retrying') : t('retryStep')}
                        </button>
                      )}
                      {detail.run.status !== 'completed' && detail.run.status !== 'cancelled' && detail.run.status !== 'archived' && !!currentStepDefinition(detail.run) && (
                        <button type="button" onClick={() => void handleAction({ action: 'skip_phase' })} className="rounded-[10px] border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-[12px] font-700 text-text-2 cursor-pointer">
                          {actionPending === 'skip_phase' ? t('skipping') : t('skipStep')}
                        </button>
                      )}
                      {detail.run.status !== 'completed' && detail.run.status !== 'cancelled' && detail.run.status !== 'archived' && (
                        <button type="button" onClick={() => void handleAction({ action: 'cancel' })} className="rounded-[10px] border border-red-500/20 bg-red-500/10 px-3 py-2 text-[12px] font-700 text-red-200 cursor-pointer">
                          {actionPending === 'cancel' ? t('cancelling') : t('cancel')}
                        </button>
                      )}
                      {(detail.run.status === 'completed' || detail.run.status === 'cancelled' || detail.run.status === 'failed') && (
                        <button type="button" onClick={() => void handleAction({ action: 'archive' })} className="rounded-[10px] border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-[12px] font-700 text-text-2 cursor-pointer">
                          {actionPending === 'archive' ? t('archiving') : t('archive')}
                        </button>
                      )}
                    </div>
                    {detail.run.waitingReason && (
                      <div className="rounded-[14px] border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-[13px] text-amber-100">
                        {detail.run.waitingReason}
                      </div>
                    )}
                    {detail.run.pauseReason && (
                      <div className="rounded-[14px] border border-indigo-500/20 bg-indigo-500/10 px-4 py-3 text-[13px] text-indigo-100">
                        {detail.run.pauseReason}
                      </div>
                    )}
                    {detail.run.summary && (
                      <div className="rounded-[16px] border border-emerald-500/14 bg-emerald-500/8 px-4 py-3">
                        <div className="text-[11px] font-700 uppercase tracking-[0.12em] text-emerald-200/80">{t('latestSummary')}</div>
                        <div className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-text-2">{detail.run.summary}</div>
                      </div>
                    )}
                    <div className="rounded-[16px] border border-white/[0.06] bg-white/[0.02] p-4">
                      <div className="text-[11px] font-700 uppercase tracking-[0.12em] text-text-3/55">{t('operatorContext')}</div>
                      <div className="mt-2 text-[12px] leading-relaxed text-text-3/68">
                        {t('operatorContextDesc')}
                      </div>
                      <textarea
                        value={contextDraft}
                        onChange={(event) => setContextDraft(event.target.value)}
                        rows={3}
                        placeholder={t('contextPlaceholder')}
                        className="mt-3 w-full rounded-[12px] border border-white/[0.06] bg-black/20 px-3 py-2.5 text-[13px] text-text outline-none placeholder:text-text-3/35"
                      />
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => void handleAction({ action: 'inject_context', context: contextDraft })}
                          disabled={!contextDraft.trim()}
                          className="rounded-[10px] border border-sky-500/20 bg-sky-500/10 px-3 py-2 text-[12px] font-700 text-sky-100 transition-all enabled:hover:bg-sky-500/16 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
                        >
                          {actionPending === 'inject_context' ? t('injecting') : t('injectContext')}
                        </button>
                        {!!detail.run.operatorContext?.length && (
                          <span className="self-center text-[12px] text-text-3/62">
                            {t('operatorNotes', { count: detail.run.operatorContext.length })}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="grid min-h-0 gap-4 xl:grid-cols-[1.2fr_0.8fr]">
                    <div className="min-h-0 space-y-4">
                      {!!Object.keys(detail.run.parallelState || {}).length && (
                        <div className="rounded-[20px] border border-white/[0.06] bg-white/[0.03] p-4">
                          <div className="text-[12px] font-700 uppercase tracking-[0.12em] text-text-3/55">{t('parallelBranches')}</div>
                          <div className="mt-3 space-y-3">
                            {Object.values(detail.run.parallelState || {}).map((state) => (
                              <div key={state.stepId} className="rounded-[16px] border border-white/[0.06] bg-white/[0.02] p-3">
                                <div className="flex flex-wrap items-center justify-between gap-3">
                                  <div>
                                    <div className="text-[13px] font-700 text-text">{stepsForRun(detail.run).find((step) => step.id === state.stepId)?.label || state.stepId}</div>
                                    <div className="mt-1 text-[11px] text-text-3/62">
                                      {state.joinReady ? t('joinReady') : t('branchesRunning', { count: state.waitingOnBranchIds?.length || 0 })}
                                    </div>
                                  </div>
                                  <span className={`rounded-full border px-2 py-0.5 text-[10px] font-700 uppercase tracking-[0.12em] ${state.joinReady ? statusTone('completed') : statusTone('waiting')}`}>
                                    {state.joinReady ? t('ready') : t('waiting')}
                                  </span>
                                </div>
                                <div className="mt-3 space-y-2">
                                  {state.branches.map((branch) => (
                                    <div key={branch.runId} className="rounded-[14px] border border-white/[0.06] bg-black/15 p-3">
                                      <div className="flex flex-wrap items-start justify-between gap-3">
                                        <div className="min-w-0 flex-1">
                                          <div className="text-[13px] font-700 text-text">{branch.label}</div>
                                          <div className="mt-1 text-[11px] text-text-3/62">
                                            {(branch.participantAgentIds || []).map((agentId) => agents[agentId]?.name || agentId).join(', ')}
                                          </div>
                                        </div>
                                        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-700 uppercase tracking-[0.12em] ${statusTone(branch.status)}`}>
                                          {branch.status}
                                        </span>
                                      </div>
                                      {(branch.summary || branch.lastError) && (
                                        <div className="mt-2 whitespace-pre-wrap text-[12px] leading-relaxed text-text-2">
                                          {branch.summary || branch.lastError}
                                        </div>
                                      )}
                                      <div className="mt-3 flex flex-wrap gap-2">
                                        <button
                                          type="button"
                                          onClick={() => handleSelectRun(branch.runId)}
                                          className="rounded-[10px] border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-[11px] font-700 text-text-2 cursor-pointer"
                                        >
                                          {t('openBranch')}
                                        </button>
                                        {(branch.status === 'failed' || branch.status === 'paused' || branch.status === 'waiting') && (
                                          <button
                                            type="button"
                                            onClick={() => void handleBranchAction(branch.runId, { action: 'retry_phase' })}
                                            className="rounded-[10px] border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-[11px] font-700 text-text-2 cursor-pointer"
                                          >
                                            {actionPending === `retry_phase:${branch.runId}` ? t('retrying') : t('retryBranch')}
                                          </button>
                                        )}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {!!Object.keys(detail.run.forEachState || {}).length && (
                        <div className="rounded-[20px] border border-white/[0.06] bg-white/[0.03] p-4">
                          <div className="text-[12px] font-700 uppercase tracking-[0.12em] text-text-3/55">{t('forEachBranches')}</div>
                          <div className="mt-3 space-y-3">
                            {Object.values(detail.run.forEachState || {}).map((state) => (
                              <div key={state.stepId} className="rounded-[16px] border border-white/[0.06] bg-white/[0.02] p-3">
                                <div className="flex flex-wrap items-center justify-between gap-3">
                                  <div>
                                    <div className="text-[13px] font-700 text-text">{stepsForRun(detail.run).find((s) => s.id === state.stepId)?.label || state.stepId}</div>
                                    <div className="mt-1 text-[11px] text-text-3/62">
                                      {t('forEachItems', { count: state.items.length })} • {state.joinReady ? t('allDone') : t('forEachRunning', { count: state.waitingOnBranchIds?.length || 0 })}
                                    </div>
                                  </div>
                                  <span className={`rounded-full border px-2 py-0.5 text-[10px] font-700 uppercase tracking-[0.12em] ${state.joinReady ? statusTone('completed') : statusTone('waiting')}`}>
                                    {state.joinReady ? t('done') : t('waiting')}
                                  </span>
                                </div>
                                <div className="mt-3 space-y-2">
                                  {state.branches.map((branch) => (
                                    <div key={branch.runId} className="rounded-[14px] border border-white/[0.06] bg-black/15 p-3">
                                      <div className="flex flex-wrap items-start justify-between gap-3">
                                        <div className="min-w-0 flex-1">
                                          <div className="text-[13px] font-700 text-text">{branch.label}</div>
                                        </div>
                                        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-700 uppercase tracking-[0.12em] ${statusTone(branch.status)}`}>
                                          {branch.status}
                                        </span>
                                      </div>
                                      {(branch.summary || branch.lastError) && (
                                        <div className="mt-2 whitespace-pre-wrap text-[12px] leading-relaxed text-text-2">
                                          {branch.summary || branch.lastError}
                                        </div>
                                      )}
                                      <div className="mt-3">
                                        <button
                                          type="button"
                                          onClick={() => handleSelectRun(branch.runId)}
                                          className="rounded-[10px] border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-[11px] font-700 text-text-2 cursor-pointer"
                                        >
                                          {t('openBranch')}
                                        </button>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {!!Object.keys(detail.run.subflowState || {}).length && (
                        <div className="rounded-[20px] border border-white/[0.06] bg-white/[0.03] p-4">
                          <div className="text-[12px] font-700 uppercase tracking-[0.12em] text-text-3/55">{t('subflows')}</div>
                          <div className="mt-3 space-y-3">
                            {Object.values(detail.run.subflowState || {}).map((state) => (
                              <div key={state.stepId} className="rounded-[16px] border border-white/[0.06] bg-white/[0.02] p-3">
                                <div className="flex flex-wrap items-center justify-between gap-3">
                                  <div>
                                    <div className="text-[13px] font-700 text-text">{stepsForRun(detail.run).find((s) => s.id === state.stepId)?.label || state.templateId}</div>
                                    <div className="mt-1 text-[11px] text-text-3/62">{t('templateLabel')}: {state.templateId}</div>
                                    {state.summary && <div className="mt-1 text-[12px] text-text-2">{state.summary}</div>}
                                    {state.lastError && <div className="mt-1 text-[12px] text-red-300">{state.lastError}</div>}
                                  </div>
                                  <span className={`rounded-full border px-2 py-0.5 text-[10px] font-700 uppercase tracking-[0.12em] ${statusTone(state.status)}`}>
                                    {state.status}
                                  </span>
                                </div>
                                <div className="mt-3">
                                  <button
                                    type="button"
                                    onClick={() => handleSelectRun(state.childRunId)}
                                    className="rounded-[10px] border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-[11px] font-700 text-text-2 cursor-pointer"
                                  >
                                    {t('openSubflow')}
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {!!Object.keys(detail.run.swarmState || {}).length && (
                        <div className="rounded-[20px] border border-white/[0.06] bg-white/[0.03] p-4">
                          <div className="text-[12px] font-700 uppercase tracking-[0.12em] text-text-3/55">{t('swarmClaims')}</div>
                          <div className="mt-3 space-y-3">
                            {Object.values(detail.run.swarmState || {}).map((state) => (
                              <div key={state.stepId} className="rounded-[16px] border border-white/[0.06] bg-white/[0.02] p-3">
                                <div className="flex flex-wrap items-center justify-between gap-3">
                                  <div>
                                    <div className="text-[13px] font-700 text-text">{stepsForRun(detail.run).find((s) => s.id === state.stepId)?.label || state.stepId}</div>
                                    <div className="mt-1 text-[11px] text-text-3/62">
                                      {t('workItems', { count: state.workItems.length })} • {t('claimedCount', { count: state.claims.length })} • {t('unclaimedCount', { count: state.unclaimedItemIds.length })}
                                      {state.timedOut && ` • ${t('timedOut')}`}
                                    </div>
                                  </div>
                                  <span className={`rounded-full border px-2 py-0.5 text-[10px] font-700 uppercase tracking-[0.12em] ${
                                    state.closedAt ? statusTone('completed') : state.timedOut ? statusTone('failed') : statusTone('waiting')
                                  }`}>
                                    {state.closedAt ? t('closed') : state.timedOut ? t('timedOut') : t('open')}
                                  </span>
                                </div>
                                <div className="mt-3 space-y-1">
                                  {state.claims.map((claim) => (
                                    <div key={claim.id} className="flex items-center justify-between rounded-[10px] border border-white/[0.06] bg-black/15 px-3 py-2">
                                      <div className="text-[12px] text-text">{claim.workItemLabel}</div>
                                      <div className="flex items-center gap-2">
                                        <span className="text-[11px] text-text-3/62">{agents[claim.agentId]?.name || claim.agentId}</span>
                                        <span className={`rounded-full border px-1.5 py-0.5 text-[9px] font-700 uppercase ${
                                          claim.status === 'completed' ? 'border-emerald-500/30 text-emerald-300' :
                                          claim.status === 'failed' ? 'border-red-500/30 text-red-300' :
                                          'border-accent-bright/30 text-accent-bright'
                                        }`}>
                                          {claim.status}
                                        </span>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      <div className="rounded-[20px] border border-white/[0.06] bg-white/[0.03] p-4">
                      <div className="text-[12px] font-700 uppercase tracking-[0.12em] text-text-3/55">{t('protocol')}</div>
                      <div className="mt-3 space-y-2">
                          {stepsForRun(detail.run).map((step, index) => {
                            const isDagMode = Object.keys(detail.run.stepState || {}).length > 0
                            const dagStatus = detail.run.stepState?.[step.id]?.status
                            const done = isDagMode
                              ? dagStatus === 'completed'
                              : detail.run.status === 'completed' ? true : index < currentStepIndex(detail.run)
                            const active = isDagMode
                              ? dagStatus === 'running'
                              : index === currentStepIndex(detail.run) && detail.run.status !== 'completed'
                            const isReady = isDagMode && dagStatus === 'ready'
                            const isWaiting = isDagMode && dagStatus === 'waiting'
                            const isFailed = isDagMode && dagStatus === 'failed'
                            const iterationCount = detail.run.loopState?.[step.id]?.iterationCount || 0
                            const parallelState = detail.run.parallelState?.[step.id] || null
                            const forEachState = detail.run.forEachState?.[step.id] || null
                            const subflowState = detail.run.subflowState?.[step.id] || null
                            const swarmState = detail.run.swarmState?.[step.id] || null
                            const joinSource = step.kind === 'join'
                              ? detail.run.parallelState?.[step.join?.parallelStepId || ''] || null
                              : null
                            const depLabels = (step.dependsOnStepIds || [])
                              .map((depId) => stepsForRun(detail.run).find((s) => s.id === depId)?.label || depId)
                            const statusColor = isFailed ? 'text-red-400' : done ? 'text-emerald-300' : active ? 'text-accent-bright' : isReady ? 'text-blue-300' : isWaiting ? 'text-amber-300' : 'text-text-3/55'
                            const statusLabel = isFailed ? t('failed') : done ? t('done') : active ? t('running') : isReady ? t('ready') : isWaiting ? t('waiting') : t('pending')
                            const borderClass = isFailed ? 'border-red-500/20 bg-red-500/10' : active ? 'border-accent-bright/20 bg-accent-soft/35' : isReady ? 'border-blue-400/20 bg-blue-500/10' : isWaiting ? 'border-amber-400/20 bg-amber-500/10' : 'border-white/[0.06] bg-white/[0.02]'
                            return (
                              <div key={step.id} className={`rounded-[14px] border px-4 py-3 ${borderClass}`}>
                                <div className="flex items-center justify-between gap-3">
                                  <div className="text-[13px] font-600 text-text">{step.label}</div>
                                  <span className={`text-[11px] ${statusColor}`}>{statusLabel}</span>
                                </div>
                                <div className="mt-1 text-[12px] text-text-3/68">{step.kind.replace(/_/g, ' ')}</div>
                                {depLabels.length > 0 && (
                                  <div className="mt-1 text-[11px] text-text-3/50">{t('dependsOn')}: {depLabels.join(', ')}</div>
                                )}
                                {isFailed && detail.run.stepState?.[step.id]?.error && (
                                  <div className="mt-2 text-[11px] text-red-300">{detail.run.stepState[step.id].error}</div>
                                )}
                                {step.kind === 'repeat' && (
                                  <div className="mt-2 text-[11px] text-text-3/58">{t('iterationProgress', { current: iterationCount, max: step.repeat?.maxIterations || 0 })}</div>
                                )}
                                {step.kind === 'parallel' && parallelState && (
                                  <div className="mt-2 text-[11px] text-text-3/58">
                                    {t('branchesCount', { count: parallelState.branches.length })} • {parallelState.joinReady ? t('joinReady') : t('branchesPending', { count: parallelState.waitingOnBranchIds?.length || 0 })}
                                  </div>
                                )}
                                {step.kind === 'for_each' && forEachState && (
                                  <div className="mt-2 text-[11px] text-text-3/58">
                                    {t('itemsCount', { count: forEachState.items.length })} • {forEachState.joinReady ? t('allDone') : t('itemsPending', { count: forEachState.waitingOnBranchIds?.length || 0 })}
                                  </div>
                                )}
                                {step.kind === 'subflow' && subflowState && (
                                  <div className="mt-2 text-[11px] text-text-3/58">
                                    {t('templateLabel')}: {subflowState.templateId} • {subflowState.status}
                                  </div>
                                )}
                                {step.kind === 'swarm_claim' && swarmState && (
                                  <div className="mt-2 text-[11px] text-text-3/58">
                                    {t('claimsCount', { count: swarmState.claims.length })} • {t('unclaimedCount', { count: swarmState.unclaimedItemIds.length })}
                                    {swarmState.timedOut && ` • ${t('timedOut')}`}
                                  </div>
                                )}
                                {step.kind === 'join' && (
                                  <div className="mt-2 text-[11px] text-text-3/58">
                                    {joinSource?.joinReady ? t('readyToMerge') : t('waitingForParallel')}
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </div>

                      <div className="rounded-[20px] border border-white/[0.06] bg-white/[0.03] p-4">
                        <div className="text-[12px] font-700 uppercase tracking-[0.12em] text-text-3/55">{t('artifacts')}</div>
                        <div className="mt-3 space-y-3">
                          {(detail.run.artifacts || []).length === 0 ? (
                            <div className="text-[13px] text-text-3/65">{t('noArtifacts')}</div>
                          ) : detail.run.artifacts?.map((artifact) => (
                            <div key={artifact.id} className="rounded-[14px] border border-white/[0.06] bg-white/[0.02] p-4">
                              <div className="flex items-center justify-between gap-3">
                                <div className="text-[13px] font-700 text-text">{artifact.title}</div>
                                <span className="text-[11px] text-text-3/60">{artifact.kind.replace(/_/g, ' ')}</span>
                              </div>
                              <div className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-text-2">{artifact.content}</div>
                              {artifactCitationMap.get(artifact.id)?.length ? (
                                <div className="mt-3">
                                  <GroundingPanel citations={artifactCitationMap.get(artifact.id)} compact />
                                </div>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="min-h-0 space-y-4">
                      <div className="rounded-[20px] border border-white/[0.06] bg-white/[0.03] p-4">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-[12px] font-700 uppercase tracking-[0.12em] text-text-3/55">{t('transcriptPreview')}</div>
                            <div className="mt-1 text-[12px] text-text-3/62">
                              {t('transcriptPreviewDesc')}
                            </div>
                          </div>
                          {detail.transcript?.id && (
                            <button
                              type="button"
                              onClick={() => router.push(`/chatrooms/${encodeURIComponent(detail.transcript?.id || '')}`)}
                              className="rounded-[10px] border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-[11px] font-700 text-text-2 cursor-pointer"
                            >
                              {t('openRoom')}
                            </button>
                          )}
                        </div>
                        <div className="mt-3 max-h-[360px] space-y-3 overflow-y-auto pr-1">
                          {detail.transcript?.messages?.length ? detail.transcript.messages.slice(-8).map((message) => (
                            <div key={message.id} className="rounded-[14px] border border-white/[0.06] bg-white/[0.02] p-3">
                              <div className="flex items-center gap-2 text-[11px] text-text-3/62">
                                <span>{message.senderName}</span>
                                <span>•</span>
                                <span>{timeAgo(message.time)}</span>
                              </div>
                              <div className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-text-2">{message.text}</div>
                            </div>
                          )) : (
                            <div className="text-[13px] text-text-3/65">{t('noTranscriptMessages')}</div>
                          )}
                        </div>
                      </div>

                      <div className="rounded-[20px] border border-white/[0.06] bg-white/[0.03] p-4">
                        <div className="text-[12px] font-700 uppercase tracking-[0.12em] text-text-3/55">{t('eventTimeline')}</div>
                        <div className="mt-3 max-h-[360px] space-y-3 overflow-y-auto pr-1">
                          {detail.events.length === 0 ? (
                            <div className="text-[13px] text-text-3/65">{t('noRunEvents')}</div>
                          ) : detail.events.map((event) => (
                            <div key={event.id} className="rounded-[14px] border border-white/[0.06] bg-white/[0.02] p-3">
                              <div className="flex items-center justify-between gap-3">
                                <div className="text-[12px] font-700 uppercase tracking-[0.12em] text-text-3/60">{event.type.replace(/_/g, ' ')}</div>
                                <div className="text-[11px] text-text-3/55">{timeAgo(event.createdAt)}</div>
                              </div>
                              <div className="mt-2 text-[13px] leading-relaxed text-text-2">{event.summary}</div>
                              {event.citations?.length ? (
                                <div className="mt-3">
                                  <GroundingPanel citations={event.citations} compact />
                                </div>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
      <StructuredSessionLauncher
        open={launcherOpen}
        onClose={() => setLauncherOpen(false)}
        onCreated={(run) => {
          setLauncherOpen(false)
          setSelectedRunId(run.id)
          router.push(`/protocols?runId=${encodeURIComponent(run.id)}`)
        }}
        allowContextSelection
      />
    </MainContent>
  )
}
