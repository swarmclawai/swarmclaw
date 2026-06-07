'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Activity, CheckCircle2, ClipboardCopy, ExternalLink, FileText, FolderOpen, PlayCircle, RotateCcw, Save, XCircle } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useAppStore } from '@/stores/use-app-store'
import { useAgentsQuery } from '@/features/agents/queries'
import {
  useAppendTaskCommentMutation,
  useCreateTaskMutation,
  useTaskExecutionPolicyDecisionMutation,
  useTasksQuery,
  useUpdateTaskMutation,
} from '@/features/tasks/queries'
import { useProjectsQuery } from '@/features/projects/queries'
import { useAppSettingsQuery } from '@/features/settings/queries'
import { useProtocolRunsQuery } from '@/features/protocols/queries'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import { AgentPickerList } from '@/components/shared/agent-picker-list'
import { DirBrowser } from '@/components/shared/dir-browser'
import { SheetFooter } from '@/components/shared/sheet-footer'
import { inputClass } from '@/components/shared/form-styles'
import { StructuredSessionLauncher } from '@/components/protocols/structured-session-launcher'
import type { BoardTask, TaskComment, TaskExecutionPolicy, TaskLivenessState, TaskQualityGateConfig } from '@/types'
import { dedup, errorMessage } from '@/lib/shared-utils'
import { SectionLabel } from '@/components/shared/section-label'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { InfoChip } from '@/components/ui/info-chip'
import { fetchTaskHandoffMarkdown, saveTaskHandoffSnapshot } from '@/lib/tasks'

function fmtTime(ts: number) {
  const d = new Date(ts)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  if (isToday) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function normalizeGateNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function livenessTone(state?: TaskLivenessState): 'neutral' | 'muted' | 'warning' | 'danger' | 'success' | 'info' | 'purple' | 'accent' {
  if (state === 'stale' || state === 'retrying') return 'warning'
  if (state === 'dead_lettered' || state === 'failed') return 'danger'
  if (state === 'blocked') return 'purple'
  if (state === 'completed') return 'success'
  if (state === 'running' || state === 'queued') return 'info'
  return 'muted'
}

function livenessLabel(task: BoardTask): string {
  const state = task.liveness?.state
  if (!state) return 'unknown'
  if (state === 'dead_lettered') return 'dead letter'
  return state.replace(/_/g, ' ')
}

function policyStageLabel(kind: 'review' | 'approval' | 'verification'): string {
  if (kind === 'approval') return 'Approval'
  if (kind === 'verification') return 'Verification'
  return 'Review'
}

function buildExecutionPolicy(enabled: boolean, stages: {
  review: boolean
  approval: boolean
  verification: boolean
}): TaskExecutionPolicy | null {
  if (!enabled) return null
  const selected = (['review', 'approval', 'verification'] as const)
    .filter((kind) => stages[kind])
    .map((kind) => ({
      id: kind,
      title: policyStageLabel(kind),
      kind,
      requiredDecisions: 1,
    }))
  if (selected.length === 0) {
    selected.push({ id: 'review', title: 'Review', kind: 'review', requiredDecisions: 1 })
  }
  return {
    enabled: true,
    mode: 'before_completion',
    stages: selected,
  }
}

export function TaskSheet() {
  const router = useRouter()
  const open = useAppStore((s) => s.taskSheetOpen)
  const setOpen = useAppStore((s) => s.setTaskSheetOpen)
  const editingId = useAppStore((s) => s.editingTaskId)
  const setEditingId = useAppStore((s) => s.setEditingTaskId)
  const activeProjectFilter = useAppStore((s) => s.activeProjectFilter)

  const viewOnly = useAppStore((s) => s.taskSheetViewOnly)
  const setViewOnly = useAppStore((s) => s.setTaskSheetViewOnly)
  const { data: tasks = {}, isLoading: tasksLoading } = useTasksQuery({ includeArchived: true, enabled: open })
  const { data: agents = {}, isLoading: agentsLoading } = useAgentsQuery({ enabled: open })
  const { data: projects = {}, isLoading: projectsLoading } = useProjectsQuery({ enabled: open })
  const { data: appSettings = {}, isLoading: settingsLoading } = useAppSettingsQuery({ enabled: open })
  const createTaskMutation = useCreateTaskMutation()
  const updateTaskMutation = useUpdateTaskMutation()
  const appendCommentMutation = useAppendTaskCommentMutation()
  const policyDecisionMutation = useTaskExecutionPolicyDecisionMutation()

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [agentId, setAgentId] = useState('')
  const [commentText, setCommentText] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [uploading, setUploading] = useState(false)
  const [cwd, setCwd] = useState('')
  const [file, setFile] = useState<string | null>(null)
  const [projectId, setProjectId] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')
  const [blockedBy, setBlockedBy] = useState<string[]>([])
  const [depSearch, setDepSearch] = useState('')
  const [depError, setDepError] = useState<string | null>(null)
  const [dueAt, setDueAt] = useState<string>('')
  const [customFields, setCustomFields] = useState<Record<string, string | number | boolean>>({})
  const [priority, setPriority] = useState<'low' | 'medium' | 'high' | 'critical' | ''>('')
  const [qualityGateEnabled, setQualityGateEnabled] = useState(true)
  const [qualityGateMinResultChars, setQualityGateMinResultChars] = useState(80)
  const [qualityGateMinEvidenceItems, setQualityGateMinEvidenceItems] = useState(2)
  const [qualityGateRequireVerification, setQualityGateRequireVerification] = useState(false)
  const [qualityGateRequireArtifact, setQualityGateRequireArtifact] = useState(false)
  const [qualityGateRequireReport, setQualityGateRequireReport] = useState(false)
  const [executionPolicyEnabled, setExecutionPolicyEnabled] = useState(false)
  const [executionPolicyReview, setExecutionPolicyReview] = useState(true)
  const [executionPolicyApproval, setExecutionPolicyApproval] = useState(false)
  const [executionPolicyVerification, setExecutionPolicyVerification] = useState(false)
  const [policyDecisionNote, setPolicyDecisionNote] = useState('')
  const [policyDecisionError, setPolicyDecisionError] = useState<string | null>(null)
  const [provisionWorkspace, setProvisionWorkspace] = useState(false)
  const [workspacePreparing, setWorkspacePreparing] = useState(false)
  const [handoffCopying, setHandoffCopying] = useState(false)
  const [handoffSaving, setHandoffSaving] = useState(false)
  const [handoffCopied, setHandoffCopied] = useState(false)
  const [handoffError, setHandoffError] = useState<string | null>(null)
  const [handoffSavedPath, setHandoffSavedPath] = useState<string | null>(null)
  const [structuredSessionOpen, setStructuredSessionOpen] = useState(false)
  const formInitRef = useRef<string | null>(null)

  const editing = editingId ? tasks[editingId] : null
  const agentList = useMemo(
    () => Object.values(agents).sort((a, b) => a.name.localeCompare(b.name)),
    [agents],
  )
  const { data: linkedProtocolRuns = [] } = useProtocolRunsQuery({
    taskId: editing?.id || null,
    limit: 6,
    enabled: open && !!editing?.id,
  })
  const activeStructuredRunId =
    linkedProtocolRuns.find((run) => !['completed', 'failed', 'cancelled', 'archived'].includes(run.status))?.id || null

  useEffect(() => {
    if (!open) return
    if (tasksLoading || agentsLoading || projectsLoading || settingsLoading) return

    const initKey = editingId ?? '__new__'
    if (formInitRef.current === initKey) return

    const defaultGateEnabled = appSettings.taskQualityGateEnabled ?? true
    const defaultGateMinResult = normalizeGateNumber(appSettings.taskQualityGateMinResultChars, 80, 10, 2000)
    const defaultGateMinEvidence = normalizeGateNumber(appSettings.taskQualityGateMinEvidenceItems, 2, 0, 8)
    const defaultGateRequireVerification = appSettings.taskQualityGateRequireVerification ?? false
    const defaultGateRequireArtifact = appSettings.taskQualityGateRequireArtifact ?? false
    const defaultGateRequireReport = appSettings.taskQualityGateRequireReport ?? false

    if (editingId && !editing) return

    if (editing) {
      setTitle(editing.title)
      setDescription(editing.description)
      setAgentId(editing.agentId)
      setProjectId(editing.projectId || '')
      setImages(editing.images || [])
      setCwd(editing.cwd || '')
      setFile(editing.file || null)
      setTags(editing.tags || [])
      setBlockedBy(editing.blockedBy || [])
      setDepSearch('')
      setDepError(null)
      setDueAt(editing.dueAt ? new Date(editing.dueAt).toISOString().slice(0, 10) : '')
      setCustomFields(editing.customFields || {})
      setPriority(editing.priority || '')
      const gate = (editing.qualityGate || null) as TaskQualityGateConfig | null
      setQualityGateEnabled(gate?.enabled ?? defaultGateEnabled)
      setQualityGateMinResultChars(normalizeGateNumber(gate?.minResultChars, defaultGateMinResult, 10, 2000))
      setQualityGateMinEvidenceItems(normalizeGateNumber(gate?.minEvidenceItems, defaultGateMinEvidence, 0, 8))
      setQualityGateRequireVerification(gate?.requireVerification ?? defaultGateRequireVerification)
      setQualityGateRequireArtifact(gate?.requireArtifact ?? defaultGateRequireArtifact)
      setQualityGateRequireReport(gate?.requireReport ?? defaultGateRequireReport)
      const policyKinds = new Set((editing.executionPolicy?.stages || []).map((stage) => stage.kind))
      setExecutionPolicyEnabled(Boolean(editing.executionPolicy?.enabled))
      setExecutionPolicyReview(policyKinds.has('review') || policyKinds.size === 0)
      setExecutionPolicyApproval(policyKinds.has('approval'))
      setExecutionPolicyVerification(policyKinds.has('verification'))
      setPolicyDecisionNote('')
      setPolicyDecisionError(null)
      setProvisionWorkspace(false)
      setHandoffCopied(false)
      setHandoffError(null)
      setHandoffSavedPath(null)
      formInitRef.current = initKey
      return
    }

    setTitle('')
    setDescription('')
    setAgentId(agentList[0]?.id || '')
    setProjectId(activeProjectFilter || '')
    setImages([])
    setCwd('')
    setFile(null)
    setTags([])
    setBlockedBy([])
    setDepSearch('')
    setDepError(null)
    setDueAt('')
    setCustomFields({})
    setPriority('')
    setQualityGateEnabled(defaultGateEnabled)
    setQualityGateMinResultChars(defaultGateMinResult)
    setQualityGateMinEvidenceItems(defaultGateMinEvidence)
    setQualityGateRequireVerification(defaultGateRequireVerification)
    setQualityGateRequireArtifact(defaultGateRequireArtifact)
    setQualityGateRequireReport(defaultGateRequireReport)
    setExecutionPolicyEnabled(false)
    setExecutionPolicyReview(true)
    setExecutionPolicyApproval(false)
    setExecutionPolicyVerification(false)
    setPolicyDecisionNote('')
    setPolicyDecisionError(null)
    setProvisionWorkspace(false)
    setHandoffCopied(false)
    setHandoffError(null)
    setHandoffSavedPath(null)
    formInitRef.current = initKey
  }, [
    activeProjectFilter,
    agentList,
    agentsLoading,
    appSettings,
    editing,
    editingId,
    open,
    projectsLoading,
    settingsLoading,
    tasksLoading,
  ])

  // Update default agent when agents load (only if no agent selected yet)
  useEffect(() => {
    if (open && !editing && !agentId && agentList.length) {
      setAgentId(agentList[0].id)
    }
  }, [open, editing, agentId, agentList])

  const onClose = () => {
    formInitRef.current = null
    setDepError(null)
    setPolicyDecisionNote('')
    setPolicyDecisionError(null)
    setHandoffCopied(false)
    setHandoffError(null)
    setHandoffSavedPath(null)
    setOpen(false)
    setEditingId(null)
  }

  const handleSave = async () => {
    const qualityGate: TaskQualityGateConfig = {
      enabled: qualityGateEnabled,
      minResultChars: qualityGateMinResultChars,
      minEvidenceItems: qualityGateMinEvidenceItems,
      requireVerification: qualityGateRequireVerification,
      requireArtifact: qualityGateRequireArtifact,
      requireReport: qualityGateRequireReport,
    }
    const executionPolicy = buildExecutionPolicy(executionPolicyEnabled, {
      review: executionPolicyReview,
      approval: executionPolicyApproval,
      verification: executionPolicyVerification,
    })

    // projectId uses null (not undefined) so the API can distinguish "clear" from "not sent"
    // projectId uses null (not undefined) so the API can distinguish "clear" from "not sent"
    const payload = {
      title: title.trim() || 'Untitled Task', description, agentId, projectId: projectId || null, images,
      cwd: cwd || undefined, file: file || undefined,
      tags, blockedBy, dueAt: dueAt ? new Date(dueAt).getTime() : null,
      customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
      priority: priority || undefined,
      qualityGate,
      executionPolicy,
      provisionWorkspace: !editing && provisionWorkspace ? true : undefined,
    } as Partial<BoardTask> & { title: string; description: string; agentId: string }
    try {
      if (editing) {
        const res = await updateTaskMutation.mutateAsync({ id: editing.id, patch: payload })
        const errMsg = res && typeof res === 'object' ? (res as unknown as Record<string, unknown>).error : undefined
        if (typeof errMsg === 'string' && errMsg.trim()) {
          setDepError(errMsg)
          return
        }
      } else {
        const res = await createTaskMutation.mutateAsync(payload)
        const errMsg = res && typeof res === 'object' ? (res as unknown as Record<string, unknown>).error : undefined
        if (typeof errMsg === 'string' && errMsg.trim()) {
          setDepError(errMsg)
          return
        }
      }
    } catch (err: unknown) {
      setDepError(errorMessage(err))
      return
    }
    setDepError(null)
    onClose()
  }

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'x-filename': file.name },
        body: await file.arrayBuffer(),
      })
      const data = await res.json()
      if (data.url) setImages((prev) => [...prev, data.url])
    } catch (err: unknown) {
      console.error('Image upload failed:', errorMessage(err))
    }
    setUploading(false)
    e.target.value = ''
  }

  const handleArchive = async () => {
    if (editing) {
      await updateTaskMutation.mutateAsync({ id: editing.id, patch: { status: 'archived' } })
      onClose()
    }
  }

  const handlePrepareWorkspace = async () => {
    if (!editing) return
    setWorkspacePreparing(true)
    try {
      await updateTaskMutation.mutateAsync({ id: editing.id, patch: { provisionWorkspace: true } })
      setDepError(null)
    } catch (err: unknown) {
      setDepError(errorMessage(err))
    } finally {
      setWorkspacePreparing(false)
    }
  }

  const handleCopyHandoff = async () => {
    if (!editing) return
    setHandoffCopying(true)
    try {
      const markdown = await fetchTaskHandoffMarkdown(editing.id)
      if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
        throw new Error('Clipboard is unavailable in this browser')
      }
      await navigator.clipboard.writeText(markdown)
      setHandoffCopied(true)
      setHandoffError(null)
      globalThis.setTimeout(() => setHandoffCopied(false), 1800)
    } catch (err: unknown) {
      setHandoffError(errorMessage(err))
    } finally {
      setHandoffCopying(false)
    }
  }

  const handleSaveHandoff = async () => {
    if (!editing) return
    setHandoffSaving(true)
    try {
      const result = await saveTaskHandoffSnapshot(editing.id, { prepareWorkspace: true })
      setHandoffSavedPath(result.files.markdownPath)
      setHandoffError(null)
    } catch (err: unknown) {
      setHandoffError(errorMessage(err))
    } finally {
      setHandoffSaving(false)
    }
  }

  const handleUnarchive = async () => {
    if (editing) {
      await updateTaskMutation.mutateAsync({ id: editing.id, patch: { status: 'backlog' } })
      onClose()
    }
  }

  const handleQueue = async () => {
    if (editing && editing.status === 'backlog') {
      await updateTaskMutation.mutateAsync({ id: editing.id, patch: { status: 'queued' } })
      onClose()
    }
  }

  const handleAddComment = async () => {
    if (!editing || !commentText.trim()) return
    const c: TaskComment = {
      id: Math.random().toString(36).slice(2, 10),
      author: 'You',
      text: commentText.trim(),
      createdAt: Date.now(),
    }
    // Use atomic append to avoid race conditions with queue-added comments
    await appendCommentMutation.mutateAsync({ id: editing.id, comment: c })
    setCommentText('')
  }

  const handlePolicyDecision = async (action: 'approve' | 'request_changes' | 'reset') => {
    if (!editing) return
    setPolicyDecisionError(null)
    try {
      await policyDecisionMutation.mutateAsync({
        id: editing.id,
        action,
        note: policyDecisionNote.trim() || null,
      })
      setPolicyDecisionNote('')
    } catch (err: unknown) {
      setPolicyDecisionError(errorMessage(err))
    }
  }

  const PRIORITY_STYLES: Record<string, string> = {
    low: 'bg-sky-500/10 border-sky-500/20 text-sky-400',
    medium: 'bg-amber-500/10 border-amber-500/20 text-amber-400',
    high: 'bg-orange-500/10 border-orange-500/20 text-orange-400',
    critical: 'bg-red-500/10 border-red-500/20 text-red-400',
  }
  const STATUS_STYLES: Record<string, string> = {
    backlog: 'bg-white/[0.06] text-text-3',
    queued: 'bg-amber-500/10 text-amber-400',
    'in-progress': 'bg-sky-500/10 text-sky-400',
    completed: 'bg-emerald-500/10 text-emerald-400',
    failed: 'bg-red-500/10 text-red-400',
    archived: 'bg-white/[0.04] text-text-3/60',
  }

  const taskAgent = editing ? agents[editing.agentId] : null
  const taskProject = editing?.projectId ? projects[editing.projectId] : null
  const currentPolicyStage = editing?.executionPolicy?.stages.find((stage) => stage.id === editing.executionPolicyState?.currentStageId) || null
  const executionPolicyStatus = editing?.executionPolicyState?.status || (editing?.executionPolicy?.enabled ? 'waiting' : 'disabled')
  const previewLinks = editing
    ? (editing.previewLinks && editing.previewLinks.length > 0
      ? editing.previewLinks
      : editing.executionWorkspace?.previewLinks || [])
    : []
  const runtimeServices = editing
    ? (editing.runtimeServices && editing.runtimeServices.length > 0
      ? editing.runtimeServices
      : editing.executionWorkspace?.runtimeServices || [])
    : []
  const handoffUrl = editing
    ? `/api/tasks/${encodeURIComponent(editing.id)}/handoff?format=markdown`
    : ''
  const handoffControls = editing ? (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button
          onClick={handleCopyHandoff}
          disabled={handoffCopying}
          className="inline-flex items-center gap-2 rounded-[10px] border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-[12px] font-600 text-text-2 hover:bg-white/[0.08] disabled:opacity-50"
          style={{ fontFamily: 'inherit' }}
        >
          <ClipboardCopy size={13} />
          {handoffCopied ? 'Copied' : handoffCopying ? 'Copying...' : 'Copy Handoff'}
        </button>
        <a
          href={handoffUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 rounded-[10px] border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-[12px] font-600 text-text-2 hover:bg-white/[0.08]"
        >
          <FileText size={13} />
          Open Packet
        </a>
        <button
          onClick={handleSaveHandoff}
          disabled={handoffSaving}
          className="inline-flex items-center gap-2 rounded-[10px] border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-[12px] font-600 text-text-2 hover:bg-white/[0.08] disabled:opacity-50"
          style={{ fontFamily: 'inherit' }}
        >
          <Save size={13} />
          {handoffSaving ? 'Saving...' : 'Save Packet'}
        </button>
      </div>
      {handoffSavedPath && (
        <code className="block text-[11px] text-text-3 font-mono break-all">{handoffSavedPath}</code>
      )}
      {handoffError && (
        <p className="text-[12px] font-600 text-red-400">{handoffError}</p>
      )}
    </div>
  ) : null

  /* ───── View-only mode ───── */
  if (viewOnly && editing) {
    return (
      <BottomSheet open={open} onClose={onClose}>
        {/* Header: title + badges + timestamps */}
        <div className="mb-8">
          <h2 className="font-display text-[28px] font-700 tracking-[-0.03em] mb-3">
            {editing.title}
          </h2>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <span className={`px-2.5 py-1 rounded-[8px] text-[12px] font-600 border border-transparent ${STATUS_STYLES[editing.status] || 'bg-white/[0.06] text-text-3'}`}>
              {editing.status}
            </span>
            {editing.priority && (
              <span className={`px-2.5 py-1 rounded-[8px] text-[12px] font-600 border ${PRIORITY_STYLES[editing.priority] || ''}`}>
                {editing.priority}
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-text-3">
            <span>Created {fmtTime(editing.createdAt)}</span>
            {editing.startedAt && <span>Started {fmtTime(editing.startedAt)}</span>}
            {editing.completedAt && <span>Completed {fmtTime(editing.completedAt)}</span>}
          </div>
        </div>

        {/* Description */}
        {editing.description && (
          <div className="mb-8">
            <SectionLabel>Description</SectionLabel>
            <div className="msg-content text-[14px] leading-[1.7] text-text-2 break-words p-4 rounded-[14px] border border-white/[0.06] bg-surface">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{editing.description}</ReactMarkdown>
            </div>
          </div>
        )}

        {editing.objective && (
          <div className="mb-8">
            <SectionLabel>Objective</SectionLabel>
            <div className="rounded-[14px] border border-white/[0.06] bg-surface px-4 py-3">
              <div className="text-[14px] font-600 text-text">{editing.objective}</div>
            </div>
          </div>
        )}

        {/* Agent */}
        {taskAgent && (
          <div className="mb-8">
            <SectionLabel>Agent</SectionLabel>
            <div className="flex items-center gap-2.5 px-4 py-3 rounded-[14px] border border-white/[0.06] bg-surface">
              <AgentAvatar seed={taskAgent.avatarSeed || null} avatarUrl={taskAgent.avatarUrl} name={taskAgent.name} size={24} />
              <span className="text-[14px] font-600 text-text">{taskAgent.name}</span>
            </div>
          </div>
        )}

        {/* Project */}
        {taskProject && (
          <div className="mb-8">
            <SectionLabel>Project</SectionLabel>
            <span className="inline-flex items-center gap-2 px-3 py-2 rounded-[10px] border border-white/[0.06] bg-surface text-[13px] font-600 text-text-2">
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: taskProject.color || '#6366F1' }} />
              {taskProject.name}
            </span>
          </div>
        )}

        {/* Directory / File */}
        {(editing.cwd || editing.file) && (
          <div className="mb-8">
            <SectionLabel>{editing.file ? 'File' : 'Directory'}</SectionLabel>
            <code className="block px-4 py-3 rounded-[14px] border border-white/[0.06] bg-surface text-[13px] text-text-2 font-mono break-all">
              {editing.file || editing.cwd}
            </code>
          </div>
        )}

        <div className="mb-8">
          <SectionLabel>Execution</SectionLabel>
          <div className="rounded-[14px] border border-white/[0.06] bg-surface p-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              {editing.liveness && (
                <InfoChip tone={livenessTone(editing.liveness.state)} title={editing.liveness.reason}>
                  <Activity size={12} />
                  {livenessLabel(editing)}
                </InfoChip>
              )}
              {editing.executionWorkspace ? (
                <InfoChip tone="accent" title={editing.executionWorkspace.path}>
                  <FolderOpen size={12} />
                  Workspace ready
                </InfoChip>
              ) : (
                <InfoChip tone="muted">
                  <FolderOpen size={12} />
                  No workspace
                </InfoChip>
              )}
              {runtimeServices.map((service) => (
                <InfoChip key={service.id} tone={service.status === 'running' ? 'success' : service.status === 'failed' ? 'danger' : 'neutral'}>
                  <PlayCircle size={12} />
                  {service.name}: {service.status}
                </InfoChip>
              ))}
            </div>
            {editing.executionWorkspace?.path && (
              <code className="block text-[12px] text-text-3 font-mono break-all">{editing.executionWorkspace.path}</code>
            )}
            {(editing.executionWorkspace?.contextPath || editing.executionWorkspace?.envPath) && (
              <div className="grid grid-cols-1 gap-2 text-[11px] text-text-3/70">
                {editing.executionWorkspace.contextPath && (
                  <div className="rounded-[10px] border border-white/[0.05] bg-white/[0.02] px-3 py-2">
                    <div className="uppercase tracking-[0.08em] text-text-3/50">Context</div>
                    <code className="mt-1 block break-all text-text-2">{editing.executionWorkspace.contextPath}</code>
                  </div>
                )}
                {editing.executionWorkspace.envPath && (
                  <div className="rounded-[10px] border border-white/[0.05] bg-white/[0.02] px-3 py-2">
                    <div className="uppercase tracking-[0.08em] text-text-3/50">Env</div>
                    <code className="mt-1 block break-all text-text-2">{editing.executionWorkspace.envPath}</code>
                  </div>
                )}
              </div>
            )}
            {editing.executionWorkspace?.envHints?.length ? (
              <div className="flex flex-wrap gap-1.5">
                {editing.executionWorkspace.envHints.slice(0, 8).map((hint) => (
                  <InfoChip key={hint.key} tone="neutral" title={hint.value}>
                    <span className="max-w-[220px] truncate">{hint.key}</span>
                  </InfoChip>
                ))}
              </div>
            ) : null}
            {previewLinks.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {previewLinks.map((link) => (
                  <a
                    key={link.id}
                    href={link.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-[8px] bg-emerald-500/10 px-2.5 py-1.5 text-[12px] font-600 text-emerald-300 hover:bg-emerald-500/15"
                  >
                    <ExternalLink size={12} />
                    {link.label || 'Preview'}
                  </a>
                ))}
              </div>
            )}
            {handoffControls}
            {!editing.executionWorkspace && (
              <button
                onClick={handlePrepareWorkspace}
                disabled={workspacePreparing}
                className="inline-flex items-center gap-2 rounded-[10px] border border-accent-bright/20 bg-accent-bright/10 px-3 py-2 text-[12px] font-600 text-accent-bright hover:bg-accent-bright/14 disabled:opacity-50"
                style={{ fontFamily: 'inherit' }}
              >
                <FolderOpen size={13} />
                {workspacePreparing ? 'Preparing...' : 'Prepare Workspace'}
              </button>
            )}
          </div>
        </div>

        {/* Tags */}
        {editing.tags && editing.tags.length > 0 && (
          <div className="mb-8">
            <SectionLabel>Tags</SectionLabel>
            <div className="flex flex-wrap gap-1.5">
              {editing.tags.map((tag) => (
                <span key={tag} className="px-2.5 py-1 rounded-[8px] bg-indigo-500/10 text-indigo-400 text-[12px] font-600">
                  {tag}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Blocked By */}
        {editing.blockedBy && editing.blockedBy.length > 0 && (
          <div className="mb-8">
            <SectionLabel>Blocked By</SectionLabel>
            <div className="flex flex-wrap gap-1.5">
              {editing.blockedBy.map((bid) => {
                const bt = tasks[bid]
                return (
                  <span key={bid} className="px-2.5 py-1 rounded-[8px] bg-white/[0.04] text-text-3 text-[12px] font-600">
                    {bt ? bt.title : bid}
                  </span>
                )
              })}
            </div>
          </div>
        )}

        {/* Blocks */}
        {editing.blocks && editing.blocks.length > 0 && (
          <div className="mb-8">
            <SectionLabel>Blocks</SectionLabel>
            <div className="flex flex-wrap gap-1.5">
              {editing.blocks.map((bid) => {
                const bt = tasks[bid]
                return bt ? (
                  <span key={bid} className="px-2.5 py-1 rounded-[8px] bg-white/[0.04] text-text-3 text-[12px] font-600">{bt.title}</span>
                ) : null
              })}
            </div>
          </div>
        )}

        {/* Due Date */}
        {editing.dueAt && (
          <div className="mb-8">
            <SectionLabel>Due Date</SectionLabel>
            <span className="text-[14px] text-text-2">{new Date(editing.dueAt).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</span>
          </div>
        )}

        {/* Custom Fields */}
        {editing.customFields && Object.keys(editing.customFields).length > 0 && (
          <div className="mb-8">
            <SectionLabel>Custom Fields</SectionLabel>
            <div className="space-y-2">
              {Object.entries(editing.customFields).map(([key, val]) => {
                const def = appSettings.taskCustomFieldDefs?.find((d) => d.key === key)
                return (
                  <div key={key} className="flex items-baseline gap-2">
                    <span className="text-[12px] font-600 text-text-3">{def?.label || key}:</span>
                    <span className="text-[13px] text-text-2">{String(val)}</span>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {editing.qualityGate?.enabled && (
          <div className="mb-8">
            <SectionLabel>Quality Gate</SectionLabel>
            <div className="p-4 rounded-[14px] border border-white/[0.06] bg-surface space-y-1.5 text-[12px] text-text-2">
              <p>Min result chars: {editing.qualityGate.minResultChars ?? 80}</p>
              <p>Min evidence signals: {editing.qualityGate.minEvidenceItems ?? 2}</p>
              <p>Verification required: {(editing.qualityGate.requireVerification ?? false) ? 'Yes' : 'No'}</p>
              <p>Artifact required: {(editing.qualityGate.requireArtifact ?? false) ? 'Yes' : 'No'}</p>
              <p>Task report required: {(editing.qualityGate.requireReport ?? false) ? 'Yes' : 'No'}</p>
            </div>
          </div>
        )}

        {editing.executionPolicy?.enabled && (
          <div className="mb-8">
            <SectionLabel>Execution Policy</SectionLabel>
            <div className="rounded-[14px] border border-white/[0.06] bg-surface p-4 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <InfoChip tone={executionPolicyStatus === 'completed' ? 'success' : executionPolicyStatus === 'changes_requested' ? 'danger' : 'warning'}>
                  {executionPolicyStatus.replace(/_/g, ' ')}
                </InfoChip>
                {currentPolicyStage && (
                  <InfoChip tone="neutral">
                    {currentPolicyStage.title}
                  </InfoChip>
                )}
              </div>
              <div className="space-y-2">
                {editing.executionPolicy.stages.map((stage) => {
                  const stageState = editing.executionPolicyState?.stages.find((item) => item.id === stage.id)
                  return (
                    <div key={stage.id} className="rounded-[10px] border border-white/[0.05] bg-white/[0.02] px-3 py-2">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-[12px] font-700 text-text">{stage.title}</div>
                        <span className="text-[11px] text-text-3">{(stageState?.status || 'pending').replace(/_/g, ' ')}</span>
                      </div>
                      <div className="mt-1 text-[11px] text-text-3/70">{stage.kind}</div>
                    </div>
                  )
                })}
              </div>
              {executionPolicyStatus !== 'completed' && (
                <div className="space-y-2">
                  <textarea
                    value={policyDecisionNote}
                    onChange={(e) => setPolicyDecisionNote(e.target.value)}
                    placeholder="Decision note..."
                    rows={2}
                    className={`${inputClass} resize-y min-h-[64px] text-[12px]`}
                    style={{ fontFamily: 'inherit' }}
                  />
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => void handlePolicyDecision('approve')}
                      disabled={policyDecisionMutation.isPending}
                      className="inline-flex items-center gap-2 rounded-[10px] border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-[12px] font-700 text-emerald-300 hover:bg-emerald-500/15 disabled:opacity-50"
                      style={{ fontFamily: 'inherit' }}
                    >
                      <CheckCircle2 size={13} />
                      Approve Stage
                    </button>
                    <button
                      onClick={() => void handlePolicyDecision('request_changes')}
                      disabled={policyDecisionMutation.isPending}
                      className="inline-flex items-center gap-2 rounded-[10px] border border-red-500/20 bg-red-500/10 px-3 py-2 text-[12px] font-700 text-red-300 hover:bg-red-500/15 disabled:opacity-50"
                      style={{ fontFamily: 'inherit' }}
                    >
                      <XCircle size={13} />
                      Request Changes
                    </button>
                    <button
                      onClick={() => void handlePolicyDecision('reset')}
                      disabled={policyDecisionMutation.isPending}
                      className="inline-flex items-center gap-2 rounded-[10px] border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-[12px] font-700 text-text-2 hover:bg-white/[0.08] disabled:opacity-50"
                      style={{ fontFamily: 'inherit' }}
                    >
                      <RotateCcw size={13} />
                      Reset Stage
                    </button>
                  </div>
                  {policyDecisionError && (
                    <p className="text-[12px] font-600 text-red-400">{policyDecisionError}</p>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Images (thumbnails only, no remove/upload) */}
        {editing.images && editing.images.length > 0 && (
          <div className="mb-8">
            <SectionLabel>Images</SectionLabel>
            <div className="flex gap-2 flex-wrap">
              {editing.images.map((url, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={i} src={url} alt="" className="w-20 h-20 rounded-[10px] object-cover border border-white/[0.08]" />
              ))}
            </div>
          </div>
        )}

        {/* Result */}
        {editing.result && (
          <div className="mb-8">
            <SectionLabel>Result</SectionLabel>
            <div className="p-4 rounded-[14px] border border-white/[0.06] bg-surface text-[13px] text-text-2 whitespace-pre-wrap max-h-[200px] overflow-y-auto">
              {editing.result}
            </div>
          </div>
        )}

        {Array.isArray(editing.outputFiles) && editing.outputFiles.length > 0 && (
          <div className="mb-8">
            <SectionLabel>Output Files</SectionLabel>
            <div className="flex flex-col gap-1.5">
              {editing.outputFiles.map((fileRef) => (
                <code key={fileRef} className="text-[12px] text-text-3 font-mono break-all">
                  {fileRef}
                </code>
              ))}
            </div>
          </div>
        )}

        {editing.completionReportPath && (
          <div className="mb-8">
            <SectionLabel>Task Report</SectionLabel>
            <code className="text-[12px] text-text-3 font-mono break-all">{editing.completionReportPath}</code>
          </div>
        )}

        {/* CLI Sessions */}
        {(editing.claudeResumeId || editing.codexResumeId || editing.opencodeResumeId || editing.geminiResumeId || editing.cliResumeId) && (
          <div className="mb-8">
            <SectionLabel>CLI Sessions</SectionLabel>
            <div className="flex flex-wrap gap-2">
              {editing.claudeResumeId && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-[10px] border border-white/[0.06] bg-surface">
                  <span className="text-[11px] font-600 text-amber-400">Claude</span>
                  <code className="text-[11px] text-text-3 font-mono">{editing.claudeResumeId}</code>
                </div>
              )}
              {editing.codexResumeId && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-[10px] border border-white/[0.06] bg-surface">
                  <span className="text-[11px] font-600 text-emerald-400">Codex</span>
                  <code className="text-[11px] text-text-3 font-mono">{editing.codexResumeId}</code>
                </div>
              )}
              {editing.opencodeResumeId && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-[10px] border border-white/[0.06] bg-surface">
                  <span className="text-[11px] font-600 text-sky-400">OpenCode</span>
                  <code className="text-[11px] text-text-3 font-mono">{editing.opencodeResumeId}</code>
                </div>
              )}
              {editing.geminiResumeId && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-[10px] border border-white/[0.06] bg-surface">
                  <span className="text-[11px] font-600 text-fuchsia-400">Gemini</span>
                  <code className="text-[11px] text-text-3 font-mono">{editing.geminiResumeId}</code>
                </div>
              )}
              {!(editing.claudeResumeId || editing.codexResumeId || editing.opencodeResumeId || editing.geminiResumeId) && editing.cliResumeId && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-[10px] border border-white/[0.06] bg-surface">
                  <span className="text-[11px] font-600 text-text-2">{editing.cliProvider || 'CLI'}</span>
                  <code className="text-[11px] text-text-3 font-mono">{editing.cliResumeId}</code>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Error / Retry notice */}
        {editing.error && (() => {
          const retryPending =
            editing.status !== 'failed' &&
            !editing.deadLetteredAt &&
            (editing.retryScheduledAt != null || /^Retry scheduled after failure/i.test(editing.error))
          const label = retryPending ? 'Retry Pending' : 'Error'
          const tone = retryPending
            ? 'border-amber-500/15 bg-amber-500/[0.04] text-amber-300/80'
            : 'border-red-500/10 bg-red-500/[0.03] text-red-400/80'
          const labelTone = retryPending ? 'text-amber-400' : 'text-red-400'
          return (
            <div className="mb-8">
              <label className={`block font-display text-[12px] font-600 uppercase tracking-[0.08em] mb-3 ${labelTone}`}>{label}</label>
              <div className={`p-4 rounded-[14px] border text-[13px] whitespace-pre-wrap ${tone}`}>
                {editing.error}
              </div>
            </div>
          )
        })()}

        {/* Comments (with input — adding comments from view mode is useful) */}
        <div className="mb-8">
          <SectionLabel>Comments {editing.comments?.length ? `(${editing.comments.length})` : ''}</SectionLabel>

          {editing.comments && editing.comments.length > 0 && (
            <div className="space-y-3 mb-4 max-h-[300px] overflow-y-auto">
              {editing.comments.map((c) => (
                <div key={c.id} className="p-3.5 rounded-[12px] border border-white/[0.06] bg-surface">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className={`text-[12px] font-600 ${c.agentId ? 'text-accent-bright' : 'text-text-2'}`}>
                      {c.author}
                    </span>
                    <span className="text-[10px] text-text-3/50 font-mono">{fmtTime(c.createdAt)}</span>
                  </div>
                  <p className="text-[13px] text-text-2 leading-[1.5] whitespace-pre-wrap">{c.text}</p>
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <input
              type="text"
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              placeholder="Add a comment..."
              className={`${inputClass} flex-1`}
              style={{ fontFamily: 'inherit' }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAddComment() } }}
            />
            <button
              onClick={handleAddComment}
              disabled={!commentText.trim()}
              className="px-4 py-3 rounded-[14px] border-none bg-accent-soft text-accent-bright text-[13px] font-600 cursor-pointer disabled:opacity-30 hover:brightness-110 transition-all shrink-0"
              style={{ fontFamily: 'inherit' }}
            >
              Post
            </button>
          </div>
        </div>

        {/* Footer: Edit + Close */}
        <div className="flex gap-3 pt-2 border-t border-white/[0.04]">
          {activeStructuredRunId && (
            <button
              onClick={() => router.push(`/protocols?runId=${encodeURIComponent(activeStructuredRunId)}`)}
              className="flex-1 py-3.5 rounded-[14px] border border-sky-500/20 bg-sky-500/10 text-sky-100 text-[15px] font-600 cursor-pointer hover:bg-sky-500/14 transition-all"
              style={{ fontFamily: 'inherit' }}
            >
              Open Session
            </button>
          )}
          <button
            onClick={() => setStructuredSessionOpen(true)}
            className="flex-1 py-3.5 rounded-[14px] border border-accent-bright/20 bg-accent-bright/10 text-accent-bright text-[15px] font-600 cursor-pointer hover:bg-accent-bright/14 transition-all"
            style={{ fontFamily: 'inherit' }}
          >
            {activeStructuredRunId ? 'Run Another Session' : 'Run Structured Session'}
          </button>
          <button
            onClick={onClose}
            className="flex-1 py-3.5 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[15px] font-600 cursor-pointer hover:bg-surface-2 transition-all"
            style={{ fontFamily: 'inherit' }}
          >
            Close
          </button>
          <button
            onClick={() => setViewOnly(false)}
            className="flex-1 py-3.5 rounded-[14px] border-none bg-accent-bright text-white text-[15px] font-600 cursor-pointer active:scale-[0.97] transition-all shadow-[0_4px_20px_rgba(99,102,241,0.25)] hover:brightness-110"
            style={{ fontFamily: 'inherit' }}
          >
            Edit
          </button>
        </div>
      </BottomSheet>
    )
  }

  /* ───── Edit / Create mode ───── */
  return (
    <BottomSheet open={open} onClose={onClose}>
      <div className="mb-8">
        <h2 className="font-display text-[28px] font-700 tracking-[-0.03em] mb-2">
          {editing ? 'Edit Task' : 'New Task'}
        </h2>
        <p className="text-[14px] text-text-3">
          {editing ? `Status: ${editing.status}` : 'Create a task and assign an agent'}
        </p>
      </div>

      <div className="mb-8">
        <SectionLabel>Title</SectionLabel>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Run full site audit"
          className={inputClass}
          style={{ fontFamily: 'inherit' }}
        />
      </div>

      <div className="mb-8">
        <SectionLabel>Description</SectionLabel>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Detailed task instructions... Use @AgentName to auto-assign"
          rows={4}
          className={`${inputClass} resize-y min-h-[100px]`}
          style={{ fontFamily: 'inherit' }}
        />
      </div>

      {editing?.objective && (
        <div className="mb-8">
          <SectionLabel>Objective</SectionLabel>
          <div className="rounded-[14px] border border-white/[0.06] bg-surface px-4 py-3 text-[12px] leading-[1.7] text-text-3/75">
            <div className="font-600 text-text">{editing.objective}</div>
          </div>
        </div>
      )}

      {/* Priority */}
      <div className="mb-8">
        <SectionLabel>Priority <span className="normal-case tracking-normal font-normal text-text-3">(optional)</span></SectionLabel>
        <div className="flex flex-wrap gap-2">
          {([['', 'None', 'bg-surface border-white/[0.06] text-text-2'],
            ['low', 'Low', 'bg-sky-500/10 border-sky-500/20 text-sky-400'],
            ['medium', 'Medium', 'bg-amber-500/10 border-amber-500/20 text-amber-400'],
            ['high', 'High', 'bg-orange-500/10 border-orange-500/20 text-orange-400'],
            ['critical', 'Critical', 'bg-red-500/10 border-red-500/20 text-red-400'],
          ] as const).map(([val, label, cls]) => (
            <button
              key={val}
              onClick={() => setPriority(val as typeof priority)}
              className={`px-4 py-3 rounded-[12px] text-[14px] font-600 cursor-pointer transition-all border
                ${priority === val
                  ? `${cls} ring-1 ring-current`
                  : 'bg-surface border-white/[0.06] text-text-2 hover:bg-surface-2'}`}
              style={{ fontFamily: 'inherit' }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Images */}
      <div className="mb-8">
        <SectionLabel>Images <span className="normal-case tracking-normal font-normal text-text-3">(optional — reference designs, mockups, etc.)</span></SectionLabel>
        {images.length > 0 && (
          <div className="flex gap-2 flex-wrap mb-3">
            {images.map((url, i) => (
              <div key={i} className="relative group">
                <img src={url} alt="" className="w-20 h-20 rounded-[10px] object-cover border border-white/[0.08]" />
                <button
                  onClick={() => setImages((prev) => prev.filter((_, idx) => idx !== i))}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-500 text-white flex items-center justify-center text-[11px] font-700 cursor-pointer
                    opacity-0 group-hover:opacity-100 transition-opacity border-none"
                >
                  x
                </button>
              </div>
            ))}
          </div>
        )}
        <label className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-[12px] border border-white/[0.06] bg-surface text-text-3 text-[13px] font-600 cursor-pointer hover:bg-surface-2 transition-colors ${uploading ? 'opacity-50 pointer-events-none' : ''}`}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
          {uploading ? 'Uploading...' : 'Add Image'}
          <input type="file" accept="image/*" onChange={handleImageUpload} className="hidden" />
        </label>
      </div>

      <div className="mb-8">
        <SectionLabel>Agent</SectionLabel>
        <AgentPickerList
          agents={agentList}
          selected={agentId}
          onSelect={(id) => setAgentId(id)}
        />
      </div>

      {/* Project (optional) */}
      <div className="mb-8">
        <SectionLabel>Project <span className="normal-case tracking-normal font-normal text-text-3">(optional)</span></SectionLabel>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setProjectId('')}
            className={`px-4 py-3 rounded-[12px] text-[14px] font-600 cursor-pointer transition-all border
              ${!projectId
                ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
                : 'bg-surface border-white/[0.06] text-text-2 hover:bg-surface-2'}`}
            style={{ fontFamily: 'inherit' }}
          >
            None
          </button>
          {Object.values(projects).map((p) => (
            <button
              key={p.id}
              onClick={() => setProjectId(p.id)}
              className={`px-4 py-3 rounded-[12px] text-[14px] font-600 cursor-pointer transition-all border flex items-center gap-2
                ${projectId === p.id
                  ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
                  : 'bg-surface border-white/[0.06] text-text-2 hover:bg-surface-2'}`}
              style={{ fontFamily: 'inherit' }}
            >
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: p.color || '#6366F1' }} />
              {p.name}
            </button>
          ))}
        </div>
      </div>

      {/* Directory (optional) */}
      <div className="mb-8">
        <SectionLabel>Directory <span className="normal-case tracking-normal font-normal text-text-3">(optional — project to work in)</span></SectionLabel>
        <DirBrowser
          value={cwd || null}
          file={file}
          onChange={(dir, f) => {
            setCwd(dir)
            setFile(f ?? null)
            if (!title) {
              const dirName = dir.split('/').pop() || ''
              setTitle(dirName)
            }
          }}
          onClear={() => { setCwd(''); setFile(null) }}
        />
      </div>

      <div className="mb-8">
        <SectionLabel>Execution Workspace</SectionLabel>
        {editing ? (
          <div className="rounded-[14px] border border-white/[0.06] bg-surface p-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              {editing.liveness && (
                <InfoChip tone={livenessTone(editing.liveness.state)} title={editing.liveness.reason}>
                  <Activity size={12} />
                  {livenessLabel(editing)}
                </InfoChip>
              )}
              {editing.executionWorkspace ? (
                <InfoChip tone="accent" title={editing.executionWorkspace.path}>
                  <FolderOpen size={12} />
                  Workspace ready
                </InfoChip>
              ) : (
                <InfoChip tone="muted">
                  <FolderOpen size={12} />
                  No workspace
                </InfoChip>
              )}
            </div>
            {editing.executionWorkspace?.path && (
              <code className="block text-[12px] text-text-3 font-mono break-all">{editing.executionWorkspace.path}</code>
            )}
            {(editing.executionWorkspace?.contextPath || editing.executionWorkspace?.envPath) && (
              <div className="grid grid-cols-1 gap-2 text-[11px] text-text-3/70">
                {editing.executionWorkspace.contextPath && (
                  <div className="rounded-[10px] border border-white/[0.05] bg-white/[0.02] px-3 py-2">
                    <div className="uppercase tracking-[0.08em] text-text-3/50">Context</div>
                    <code className="mt-1 block break-all text-text-2">{editing.executionWorkspace.contextPath}</code>
                  </div>
                )}
                {editing.executionWorkspace.envPath && (
                  <div className="rounded-[10px] border border-white/[0.05] bg-white/[0.02] px-3 py-2">
                    <div className="uppercase tracking-[0.08em] text-text-3/50">Env</div>
                    <code className="mt-1 block break-all text-text-2">{editing.executionWorkspace.envPath}</code>
                  </div>
                )}
              </div>
            )}
            {editing.executionWorkspace?.envHints?.length ? (
              <div className="flex flex-wrap gap-1.5">
                {editing.executionWorkspace.envHints.slice(0, 8).map((hint) => (
                  <InfoChip key={hint.key} tone="neutral" title={hint.value}>
                    <span className="max-w-[220px] truncate">{hint.key}</span>
                  </InfoChip>
                ))}
              </div>
            ) : null}
            {previewLinks.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {previewLinks.map((link) => (
                  <a
                    key={link.id}
                    href={link.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-[8px] bg-emerald-500/10 px-2.5 py-1.5 text-[12px] font-600 text-emerald-300 hover:bg-emerald-500/15"
                  >
                    <ExternalLink size={12} />
                    {link.label || 'Preview'}
                  </a>
                ))}
              </div>
            )}
            {handoffControls}
            <button
              onClick={handlePrepareWorkspace}
              disabled={workspacePreparing}
              className="inline-flex items-center gap-2 rounded-[10px] border border-accent-bright/20 bg-accent-bright/10 px-3 py-2 text-[12px] font-600 text-accent-bright hover:bg-accent-bright/14 disabled:opacity-50"
              style={{ fontFamily: 'inherit' }}
            >
              <FolderOpen size={13} />
              {workspacePreparing ? 'Preparing...' : editing.executionWorkspace ? 'Refresh Workspace' : 'Prepare Workspace'}
            </button>
          </div>
        ) : (
          <label className="flex items-center gap-2 rounded-[14px] border border-white/[0.06] bg-surface px-4 py-3 text-[13px] text-text-2">
            <input
              type="checkbox"
              checked={provisionWorkspace}
              onChange={(e) => setProvisionWorkspace(e.target.checked)}
              className="h-4 w-4 rounded border-white/20 accent-accent"
            />
            Prepare a task-scoped workspace when this task is created
          </label>
        )}
      </div>

      {/* Tags */}
      <div className="mb-8">
        <SectionLabel>Tags <span className="normal-case tracking-normal font-normal text-text-3">(optional)</span></SectionLabel>
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-3">
            {tags.map((tag) => (
              <span key={tag} className="inline-flex items-center gap-1 px-2 py-1 rounded-[8px] bg-indigo-500/10 text-indigo-400 text-[12px] font-600">
                {tag}
                <button onClick={() => setTags((prev) => prev.filter((t) => t !== tag))} className="text-indigo-400/60 hover:text-indigo-400 cursor-pointer border-none bg-transparent p-0 text-[14px] leading-none">&times;</button>
              </span>
            ))}
          </div>
        )}
        <div className="relative">
          <input
            type="text"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && tagInput.trim()) {
                e.preventDefault()
                const t = tagInput.trim().toLowerCase()
                if (!tags.includes(t)) setTags((prev) => [...prev, t])
                setTagInput('')
              }
            }}
            placeholder="Type and press Enter to add..."
            className={inputClass}
            style={{ fontFamily: 'inherit' }}
            list="tag-suggestions"
          />
          <datalist id="tag-suggestions">
            {dedup(Object.values(tasks).flatMap((t) => t.tags || []))
              .filter((t) => !tags.includes(t) && t.includes(tagInput.toLowerCase()))
              .slice(0, 10)
              .map((t) => <option key={t} value={t} />)}
          </datalist>
        </div>
      </div>

      {/* Dependencies */}
      <div className="mb-8">
        <SectionLabel>Blocked By <span className="normal-case tracking-normal font-normal text-text-3">(tasks that must complete first)</span></SectionLabel>
        {/* Selected blockers as removable chips */}
        {blockedBy.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-3">
            {blockedBy.map((bid) => {
              const bt = tasks[bid]
              return (
                <span key={bid} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-[8px] bg-rose-500/10 text-rose-400 text-[12px] font-600">
                  {bt ? bt.title : bid}
                  <button
                    onClick={() => setBlockedBy((prev) => prev.filter((b) => b !== bid))}
                    className="text-rose-400/60 hover:text-rose-400 cursor-pointer border-none bg-transparent p-0 text-[14px] leading-none"
                  >
                    &times;
                  </button>
                </span>
              )
            })}
          </div>
        )}
        {/* Searchable dropdown for adding dependencies */}
        <div className="relative">
          <input
            type="text"
            value={depSearch}
            onChange={(e) => setDepSearch(e.target.value)}
            placeholder="Search tasks to add as dependency..."
            className={inputClass}
            style={{ fontFamily: 'inherit' }}
          />
          {depSearch.trim() && (
            <div className="absolute z-20 top-full left-0 right-0 mt-1 max-h-[200px] overflow-y-auto rounded-[12px] border border-white/[0.08] bg-surface shadow-xl">
              {Object.values(tasks)
                .filter((t) =>
                  t.id !== editingId &&
                  t.status !== 'archived' &&
                  !blockedBy.includes(t.id) &&
                  t.title.toLowerCase().includes(depSearch.toLowerCase())
                )
                .slice(0, 10)
                .map((t) => (
                  <button
                    key={t.id}
                    onClick={() => {
                      setBlockedBy((prev) => [...prev, t.id])
                      setDepSearch('')
                    }}
                    className="w-full text-left px-4 py-2.5 text-[13px] text-text-2 hover:bg-surface-2 cursor-pointer border-none bg-transparent transition-colors flex items-center gap-2"
                    style={{ fontFamily: 'inherit' }}
                  >
                    <span className="flex-1 truncate">{t.title}</span>
                    <span className="text-[10px] text-text-3 shrink-0">({t.status})</span>
                  </button>
                ))}
              {Object.values(tasks).filter((t) =>
                t.id !== editingId &&
                t.status !== 'archived' &&
                !blockedBy.includes(t.id) &&
                t.title.toLowerCase().includes(depSearch.toLowerCase())
              ).length === 0 && (
                <div className="px-4 py-3 text-[13px] text-text-3">No matching tasks</div>
              )}
            </div>
          )}
        </div>
        {depError && (
          <p className="mt-2 text-[12px] text-red-400 font-600">{depError}</p>
        )}
        {editing && Array.isArray(editing.blocks) && editing.blocks.length > 0 && (
          <div className="mt-3">
            <span className="text-[11px] font-600 text-text-3 uppercase tracking-[0.06em]">Blocks:</span>
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {editing.blocks.map((bid) => {
                const bt = tasks[bid]
                return bt ? (
                  <span key={bid} className="px-2 py-1 rounded-[6px] bg-white/[0.04] text-text-3 text-[11px] font-600">{bt.title}</span>
                ) : null
              })}
            </div>
          </div>
        )}
      </div>

      {/* Due Date */}
      <div className="mb-8">
        <SectionLabel>Due Date <span className="normal-case tracking-normal font-normal text-text-3">(optional)</span></SectionLabel>
        <input
          type="date"
          value={dueAt}
          onChange={(e) => setDueAt(e.target.value)}
          className={`${inputClass} appearance-none`}
          style={{ fontFamily: 'inherit', colorScheme: 'dark' }}
        />
      </div>

      <div className="mb-8">
        <SectionLabel>Quality Gate</SectionLabel>
        <p className="text-[12px] text-text-3 mb-3">
          Checks that must pass before this task can be marked completed.
        </p>
        <div className="p-4 rounded-[14px] border border-white/[0.06] bg-surface">
          <button
            onClick={() => setQualityGateEnabled((prev) => !prev)}
            className={`relative w-10 h-[22px] rounded-full transition-colors duration-200 cursor-pointer ${qualityGateEnabled ? 'bg-accent' : 'bg-white/[0.12]'}`}
          >
            <span className={`absolute top-[3px] left-[3px] w-4 h-4 rounded-full bg-white transition-transform duration-200 ${qualityGateEnabled ? 'translate-x-[18px]' : ''}`} />
          </button>
          <span className="ml-2 text-[12px] text-text-2">{qualityGateEnabled ? 'Enabled' : 'Disabled'}</span>

          {qualityGateEnabled && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
              <div>
                <label className="block text-[11px] text-text-3 mb-1.5">Min Result Chars</label>
                <input
                  type="number"
                  min={10}
                  max={2000}
                  value={qualityGateMinResultChars}
                  onChange={(e) => setQualityGateMinResultChars(normalizeGateNumber(e.target.value, 80, 10, 2000))}
                  className={inputClass}
                  style={{ fontFamily: 'inherit' }}
                />
              </div>
              <div>
                <label className="block text-[11px] text-text-3 mb-1.5">Min Evidence Signals</label>
                <input
                  type="number"
                  min={0}
                  max={8}
                  value={qualityGateMinEvidenceItems}
                  onChange={(e) => setQualityGateMinEvidenceItems(normalizeGateNumber(e.target.value, 2, 0, 8))}
                  className={inputClass}
                  style={{ fontFamily: 'inherit' }}
                />
              </div>
              <label className="flex items-center gap-2 text-[12px] text-text-2">
                <input
                  type="checkbox"
                  checked={qualityGateRequireVerification}
                  onChange={(e) => setQualityGateRequireVerification(e.target.checked)}
                  className="h-4 w-4 rounded border-white/20 accent-accent"
                />
                Require verification evidence (tests/lint/build)
              </label>
              <label className="flex items-center gap-2 text-[12px] text-text-2">
                <input
                  type="checkbox"
                  checked={qualityGateRequireArtifact}
                  onChange={(e) => setQualityGateRequireArtifact(e.target.checked)}
                  className="h-4 w-4 rounded border-white/20 accent-accent"
                />
                Require artifact evidence (upload URL or task artifacts)
              </label>
              <label className="flex items-center gap-2 text-[12px] text-text-2 md:col-span-2">
                <input
                  type="checkbox"
                  checked={qualityGateRequireReport}
                  onChange={(e) => setQualityGateRequireReport(e.target.checked)}
                  className="h-4 w-4 rounded border-white/20 accent-accent"
                />
                Require generated task report
              </label>
            </div>
          )}
        </div>
      </div>

      <div className="mb-8">
        <SectionLabel>Execution Policy</SectionLabel>
        <div className="p-4 rounded-[14px] border border-white/[0.06] bg-surface">
          <button
            onClick={() => setExecutionPolicyEnabled((prev) => !prev)}
            className={`relative w-10 h-[22px] rounded-full transition-colors duration-200 cursor-pointer ${executionPolicyEnabled ? 'bg-accent' : 'bg-white/[0.12]'}`}
          >
            <span className={`absolute top-[3px] left-[3px] w-4 h-4 rounded-full bg-white transition-transform duration-200 ${executionPolicyEnabled ? 'translate-x-[18px]' : ''}`} />
          </button>
          <span className="ml-2 text-[12px] text-text-2">{executionPolicyEnabled ? 'Enabled' : 'Disabled'}</span>

          {executionPolicyEnabled && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4">
              <label className="flex items-center gap-2 text-[12px] text-text-2">
                <input
                  type="checkbox"
                  checked={executionPolicyReview}
                  onChange={(e) => setExecutionPolicyReview(e.target.checked)}
                  className="h-4 w-4 rounded border-white/20 accent-accent"
                />
                Review
              </label>
              <label className="flex items-center gap-2 text-[12px] text-text-2">
                <input
                  type="checkbox"
                  checked={executionPolicyApproval}
                  onChange={(e) => setExecutionPolicyApproval(e.target.checked)}
                  className="h-4 w-4 rounded border-white/20 accent-accent"
                />
                Approval
              </label>
              <label className="flex items-center gap-2 text-[12px] text-text-2">
                <input
                  type="checkbox"
                  checked={executionPolicyVerification}
                  onChange={(e) => setExecutionPolicyVerification(e.target.checked)}
                  className="h-4 w-4 rounded border-white/20 accent-accent"
                />
                Verification
              </label>
              {editing?.executionPolicyState && (
                <div className="md:col-span-3 rounded-[10px] border border-white/[0.05] bg-white/[0.02] px-3 py-2 text-[12px] text-text-3">
                  Current state: {executionPolicyStatus.replace(/_/g, ' ')}
                  {currentPolicyStage ? ` at ${currentPolicyStage.title}` : ''}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Custom Fields */}
      {appSettings.taskCustomFieldDefs && appSettings.taskCustomFieldDefs.length > 0 && (
        <div className="mb-8">
          <SectionLabel>Custom Fields</SectionLabel>
          <div className="space-y-4">
            {appSettings.taskCustomFieldDefs.map((def) => (
              <div key={def.key}>
                <label className="block text-[12px] text-text-3 mb-1.5">{def.label}</label>
                {def.type === 'select' ? (
                  <select
                    value={String(customFields[def.key] ?? '')}
                    onChange={(e) => setCustomFields((prev) => ({ ...prev, [def.key]: e.target.value }))}
                    className={inputClass}
                    style={{ fontFamily: 'inherit' }}
                  >
                    <option value="">—</option>
                    {def.options?.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                  </select>
                ) : (
                  <input
                    type={def.type === 'number' ? 'number' : 'text'}
                    value={String(customFields[def.key] ?? '')}
                    onChange={(e) => setCustomFields((prev) => ({
                      ...prev,
                      [def.key]: def.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value,
                    }))}
                    className={inputClass}
                    style={{ fontFamily: 'inherit' }}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {editing?.result && (
        <div className="mb-8">
          <SectionLabel>Result</SectionLabel>
          <div className="p-4 rounded-[14px] border border-white/[0.06] bg-surface text-[13px] text-text-2 whitespace-pre-wrap max-h-[200px] overflow-y-auto">
            {editing.result}
          </div>
        </div>
      )}

      {editing && (editing.claudeResumeId || editing.codexResumeId || editing.opencodeResumeId || editing.geminiResumeId || editing.cliResumeId) && (
        <div className="mb-8">
          <SectionLabel>CLI Sessions</SectionLabel>
          <div className="flex flex-wrap gap-2">
            {editing.claudeResumeId && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-[10px] border border-white/[0.06] bg-surface">
                <span className="text-[11px] font-600 text-amber-400">Claude</span>
                <code className="text-[11px] text-text-3 font-mono">{editing.claudeResumeId}</code>
              </div>
            )}
            {editing.codexResumeId && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-[10px] border border-white/[0.06] bg-surface">
                <span className="text-[11px] font-600 text-emerald-400">Codex</span>
                <code className="text-[11px] text-text-3 font-mono">{editing.codexResumeId}</code>
              </div>
            )}
            {editing.opencodeResumeId && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-[10px] border border-white/[0.06] bg-surface">
                <span className="text-[11px] font-600 text-sky-400">OpenCode</span>
                <code className="text-[11px] text-text-3 font-mono">{editing.opencodeResumeId}</code>
              </div>
            )}
            {editing.geminiResumeId && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-[10px] border border-white/[0.06] bg-surface">
                <span className="text-[11px] font-600 text-fuchsia-400">Gemini</span>
                <code className="text-[11px] text-text-3 font-mono">{editing.geminiResumeId}</code>
              </div>
            )}
            {!(editing.claudeResumeId || editing.codexResumeId || editing.opencodeResumeId || editing.geminiResumeId) && editing.cliResumeId && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-[10px] border border-white/[0.06] bg-surface">
                <span className="text-[11px] font-600 text-text-2">{editing.cliProvider || 'CLI'}</span>
                <code className="text-[11px] text-text-3 font-mono">{editing.cliResumeId}</code>
              </div>
            )}
          </div>
        </div>
      )}

      {editing?.error && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-red-400 uppercase tracking-[0.08em] mb-3">Error</label>
          <div className="p-4 rounded-[14px] border border-red-500/10 bg-red-500/[0.03] text-[13px] text-red-400/80 whitespace-pre-wrap">
            {editing.error}
          </div>
        </div>
      )}

      {/* Comments */}
      {editing && (
        <div className="mb-8">
          <SectionLabel>Comments {editing.comments?.length ? `(${editing.comments.length})` : ''}</SectionLabel>

          {editing.comments && editing.comments.length > 0 && (
            <div className="space-y-3 mb-4 max-h-[300px] overflow-y-auto">
              {editing.comments.map((c) => (
                <div key={c.id} className="p-3.5 rounded-[12px] border border-white/[0.06] bg-surface">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className={`text-[12px] font-600 ${c.agentId ? 'text-accent-bright' : 'text-text-2'}`}>
                      {c.author}
                    </span>
                    <span className="text-[10px] text-text-3/50 font-mono">{fmtTime(c.createdAt)}</span>
                  </div>
                  <p className="text-[13px] text-text-2 leading-[1.5] whitespace-pre-wrap">{c.text}</p>
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <input
              type="text"
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              placeholder="Add a comment..."
              className={`${inputClass} flex-1`}
              style={{ fontFamily: 'inherit' }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAddComment() } }}
            />
            <button
              onClick={handleAddComment}
              disabled={!commentText.trim()}
              className="px-4 py-3 rounded-[14px] border-none bg-accent-soft text-accent-bright text-[13px] font-600 cursor-pointer disabled:opacity-30 hover:brightness-110 transition-all shrink-0"
              style={{ fontFamily: 'inherit' }}
            >
              Post
            </button>
          </div>
        </div>
      )}

      <SheetFooter
        onCancel={onClose}
        onSave={handleSave}
        saveLabel={editing ? 'Save' : 'Create'}
        saveDisabled={!title.trim() || !agentId}
        left={<>
          {editing && activeStructuredRunId && (
            <button onClick={() => router.push(`/protocols?runId=${encodeURIComponent(activeStructuredRunId)}`)} className="py-3.5 px-6 rounded-[14px] border border-sky-500/20 bg-transparent text-sky-100 text-[15px] font-600 cursor-pointer hover:bg-sky-500/10 transition-all" style={{ fontFamily: 'inherit' }}>
              Open Session
            </button>
          )}
          {editing && (
            <button onClick={() => setStructuredSessionOpen(true)} className="py-3.5 px-6 rounded-[14px] border border-accent-bright/20 bg-transparent text-accent-bright text-[15px] font-600 cursor-pointer hover:bg-accent-bright/10 transition-all" style={{ fontFamily: 'inherit' }}>
              {activeStructuredRunId ? 'Run Another Session' : 'Run Structured Session'}
            </button>
          )}
          {editing && editing.status !== 'archived' && (
            <button onClick={handleArchive} className="py-3.5 px-6 rounded-[14px] border border-white/[0.08] bg-transparent text-text-3 text-[15px] font-600 cursor-pointer hover:bg-white/[0.04] transition-all" style={{ fontFamily: 'inherit' }}>
              Archive
            </button>
          )}
          {editing && editing.status === 'archived' && (
            <button onClick={handleUnarchive} className="py-3.5 px-6 rounded-[14px] border border-accent-bright/20 bg-transparent text-accent-bright text-[15px] font-600 cursor-pointer hover:bg-accent-bright/10 transition-all" style={{ fontFamily: 'inherit' }}>
              Unarchive
            </button>
          )}
          {editing && editing.status === 'backlog' && (
            <button onClick={handleQueue} className="py-3.5 px-6 rounded-[14px] border border-amber-500/20 bg-transparent text-amber-400 text-[15px] font-600 cursor-pointer hover:bg-amber-500/10 transition-all" style={{ fontFamily: 'inherit' }}>
              Queue
            </button>
          )}
        </>}
      />
      <StructuredSessionLauncher
        open={structuredSessionOpen}
        onClose={() => setStructuredSessionOpen(false)}
        onCreated={(run) => {
          router.push(`/protocols?runId=${encodeURIComponent(run.id)}`)
        }}
        initialContext={{
          taskId: editing?.id || null,
          taskLabel: editing?.title || null,
          participantAgentIds: editing?.agentId ? [editing.agentId] : agentId ? [agentId] : [],
          facilitatorAgentId: editing?.agentId || agentId || null,
          title: editing ? `Structured session: ${editing.title}` : title ? `Structured session: ${title}` : null,
          goal: editing?.description || description || title || null,
        }}
      />
    </BottomSheet>
  )
}
