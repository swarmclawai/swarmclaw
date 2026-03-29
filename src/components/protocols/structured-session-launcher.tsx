'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAgentsQuery } from '@/features/agents/queries'
import { useChatroomsQuery } from '@/features/chatrooms/queries'
import { useCreateProtocolRunMutation, useProtocolTemplatesQuery } from '@/features/protocols/queries'
import { useTasksQuery } from '@/features/tasks/queries'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import { SheetFooter } from '@/components/shared/sheet-footer'
import type { BoardTask, Chatroom, ProtocolRun, ProtocolTemplate } from '@/types'

export type StructuredSessionLaunchContext = {
  templateId?: string | null
  title?: string | null
  goal?: string | null
  kickoffMessage?: string | null
  participantAgentIds?: string[]
  facilitatorAgentId?: string | null
  sessionId?: string | null
  sessionLabel?: string | null
  parentChatroomId?: string | null
  parentChatroomLabel?: string | null
  taskId?: string | null
  taskLabel?: string | null
  autoStart?: boolean
  createTranscript?: boolean
}

type AgentList = Record<string, { id: string; name: string }>
type TaskList = Record<string, BoardTask>

type Props = {
  open: boolean
  onClose: () => void
  onCreated?: (run: ProtocolRun) => void
  initialContext?: StructuredSessionLaunchContext | null
  allowContextSelection?: boolean
  variant?: 'default' | 'breakout'
}

type FormState = {
  title: string
  templateId: string
  goal: string
  kickoffMessage: string
  roundLimit: string
  decisionMode: string
  participantAgentIds: string[]
  facilitatorAgentId: string
  sessionId: string
  parentChatroomId: string
  taskId: string
  autoStart: boolean
  createTranscript: boolean
}

const DEFAULT_TEMPLATE_ID = 'facilitated_discussion'

function buildDefaultTitle(context: StructuredSessionLaunchContext | null | undefined): string {
  if (context?.title?.trim()) return context.title.trim()
  if (context?.taskLabel?.trim()) return `Structured session: ${context.taskLabel.trim()}`
  if (context?.parentChatroomLabel?.trim()) return `Structured session: ${context.parentChatroomLabel.trim()}`
  if (context?.sessionLabel?.trim()) return `Structured session: ${context.sessionLabel.trim()}`
  return ''
}

function buildInitialState(context: StructuredSessionLaunchContext | null | undefined): FormState {
  return {
    title: buildDefaultTitle(context),
    templateId: context?.templateId?.trim() || DEFAULT_TEMPLATE_ID,
    goal: context?.goal?.trim() || '',
    kickoffMessage: context?.kickoffMessage?.trim() || '',
    roundLimit: '',
    decisionMode: '',
    participantAgentIds: Array.isArray(context?.participantAgentIds) ? context.participantAgentIds.filter(Boolean) : [],
    facilitatorAgentId: context?.facilitatorAgentId?.trim() || '',
    sessionId: context?.sessionId?.trim() || '',
    parentChatroomId: context?.parentChatroomId?.trim() || '',
    taskId: context?.taskId?.trim() || '',
    autoStart: context?.autoStart !== false,
    createTranscript: context?.createTranscript !== false,
  }
}

function contextChip(label: string, value: string | null | undefined): { label: string; value: string } | null {
  if (!value?.trim()) return null
  return { label, value: value.trim() }
}

export function StructuredSessionLauncher({
  open,
  onClose,
  onCreated,
  initialContext,
  allowContextSelection = false,
  variant = 'default',
}: Props) {
  const [saving, setSaving] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(() => buildInitialState(initialContext))
  const templatesQuery = useProtocolTemplatesQuery({ enabled: open })
  const agentsQuery = useAgentsQuery({ enabled: open })
  const chatroomsQuery = useChatroomsQuery({ enabled: open && allowContextSelection })
  const tasksQuery = useTasksQuery({ includeArchived: true, enabled: open && allowContextSelection })
  const createRunMutation = useCreateProtocolRunMutation()
  const templates = templatesQuery.data ?? []
  const agents = agentsQuery.data ?? {}
  const chatrooms = chatroomsQuery.data ?? {}
  const tasks = tasksQuery.data ?? {}
  const loading = (
    templatesQuery.isLoading
    || agentsQuery.isLoading
    || chatroomsQuery.isLoading
    || tasksQuery.isLoading
  )
  const breakoutMode = variant === 'breakout'

  useEffect(() => {
    if (!open) return
    setForm(buildInitialState(initialContext))
    setError(null)
    setAdvancedOpen(false)
    setSaving(false)
  }, [initialContext, open])

  const agentOptions = useMemo(
    () => Object.values(agents).sort((a, b) => a.name.localeCompare(b.name)),
    [agents],
  )
  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === form.templateId) || null,
    [form.templateId, templates],
  )
  const linkedContext = useMemo(
    () => [
      contextChip('Chat', initialContext?.sessionLabel),
      contextChip('Chatroom', initialContext?.parentChatroomLabel),
      contextChip('Task', initialContext?.taskLabel),
    ].filter(Boolean) as Array<{ label: string; value: string }>,
    [initialContext],
  )
  const breakoutParticipantNames = useMemo(
    () => form.participantAgentIds.map((id) => agents[id]?.name).filter(Boolean) as string[],
    [agents, form.participantAgentIds],
  )
  const launcherTitle = breakoutMode ? 'Start Breakout Session' : 'Start Structured Session'
  const launcherDescription = breakoutMode
    ? 'Spin up a focused bounded run from this room without turning the room itself into orchestration state.'
    : 'Launch a bounded structured session with one or more agents.'
  const launcherHeroCopy = breakoutMode
    ? 'Turn the current room context into a focused bounded run. Participants are auto-filled from the room, and you can watch the live room once the session starts.'
    : 'Launch a temporary, bounded run from the work you are already doing. Templates stay reusable, while each run keeps its own transcript, outputs, and summary.'

  const handleSave = async () => {
    if (!form.title.trim()) {
      setError('A structured session title is required.')
      return
    }
    if (form.participantAgentIds.length === 0) {
      setError('Select at least one participant.')
      return
    }
    setSaving(true)
    try {
      const run = await createRunMutation.mutateAsync({
        title: form.title.trim(),
        templateId: form.templateId,
        participantAgentIds: form.participantAgentIds,
        facilitatorAgentId: form.facilitatorAgentId || null,
        sessionId: form.sessionId || null,
        parentChatroomId: form.parentChatroomId || null,
        taskId: form.taskId || null,
        autoStart: form.autoStart,
        createTranscript: form.createTranscript,
        config: {
          goal: form.goal.trim() || null,
          kickoffMessage: form.kickoffMessage.trim() || null,
          roundLimit: form.roundLimit.trim() ? Number.parseInt(form.roundLimit, 10) : null,
          decisionMode: form.decisionMode.trim() || null,
        },
      })
      onCreated?.(run)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to start structured session.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      wide
      title={launcherTitle}
      description={launcherDescription}
    >
      <div className="mb-8">
        <div className="inline-flex rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1 text-[11px] font-700 uppercase tracking-[0.14em] text-text-3/70">
          Structured Sessions
        </div>
        <h2 className="mt-4 font-display text-[28px] font-700 tracking-[-0.03em] text-text">{launcherTitle}</h2>
        <p className="mt-2 max-w-[720px] text-[14px] leading-relaxed text-text-3/72">
          {launcherHeroCopy}
        </p>
      </div>

      {linkedContext.length > 0 && (
        <div className="mb-6 rounded-[16px] border border-white/[0.06] bg-white/[0.03] p-4">
          <div className="text-[11px] font-700 uppercase tracking-[0.12em] text-text-3/55">Starting From</div>
          <div className="mt-3 flex flex-wrap gap-2">
            {linkedContext.map((entry) => (
              <span key={`${entry.label}-${entry.value}`} className="rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-[12px] text-text-2">
                <span className="mr-1 text-text-3/60">{entry.label}:</span>
                {entry.value}
              </span>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="mb-6 rounded-[14px] border border-red-500/18 bg-red-500/10 px-4 py-3 text-[13px] text-red-200">
          {error}
        </div>
      )}

      <div className="space-y-6">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="md:col-span-2">
            <div className="text-[11px] font-700 uppercase tracking-[0.12em] text-text-3/55">Title</div>
            <input
              value={form.title}
              onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
              placeholder="What should this run be called?"
              className="mt-2 w-full rounded-[12px] border border-white/[0.06] bg-white/[0.04] px-3 py-2.5 text-[14px] text-text outline-none placeholder:text-text-3/35"
            />
          </div>

          {!breakoutMode && (
            <>
              <div>
                <div className="text-[11px] font-700 uppercase tracking-[0.12em] text-text-3/55">Template</div>
                <select
                  value={form.templateId}
                  onChange={(event) => setForm((current) => ({ ...current, templateId: event.target.value }))}
                  className="mt-2 w-full rounded-[12px] border border-white/[0.06] bg-white/[0.04] px-3 py-2.5 text-[14px] text-text outline-none"
                >
                  {templates.map((template) => (
                    <option key={template.id} value={template.id}>{template.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <div className="text-[11px] font-700 uppercase tracking-[0.12em] text-text-3/55">Facilitator</div>
                <select
                  value={form.facilitatorAgentId}
                  onChange={(event) => setForm((current) => ({ ...current, facilitatorAgentId: event.target.value }))}
                  className="mt-2 w-full rounded-[12px] border border-white/[0.06] bg-white/[0.04] px-3 py-2.5 text-[14px] text-text outline-none"
                >
                  <option value="">Use the first participant</option>
                  {agentOptions.map((agent) => (
                    <option key={agent.id} value={agent.id}>{agent.name}</option>
                  ))}
                </select>
              </div>
            </>
          )}

          <div className="md:col-span-2">
            <div className="text-[11px] font-700 uppercase tracking-[0.12em] text-text-3/55">Goal</div>
            <input
              value={form.goal}
              onChange={(event) => setForm((current) => ({ ...current, goal: event.target.value }))}
              placeholder="What should this structured session accomplish?"
              className="mt-2 w-full rounded-[12px] border border-white/[0.06] bg-white/[0.04] px-3 py-2.5 text-[14px] text-text outline-none placeholder:text-text-3/35"
            />
          </div>

          <div className="md:col-span-2">
            <div className="text-[11px] font-700 uppercase tracking-[0.12em] text-text-3/55">Kickoff Context</div>
            <textarea
              value={form.kickoffMessage}
              onChange={(event) => setForm((current) => ({ ...current, kickoffMessage: event.target.value }))}
              placeholder="Optional background, constraints, or initial framing"
              rows={4}
              className="mt-2 w-full rounded-[12px] border border-white/[0.06] bg-white/[0.04] px-3 py-2.5 text-[14px] text-text outline-none placeholder:text-text-3/35"
            />
          </div>
        </div>

        {breakoutMode ? (
          <div className="rounded-[16px] border border-white/[0.06] bg-white/[0.03] p-4">
            <div className="text-[11px] font-700 uppercase tracking-[0.12em] text-text-3/55">Room Participants</div>
            <div className="mt-3 flex flex-wrap gap-2">
              {loading ? (
                <div className="text-[13px] text-text-3/60">Loading room members…</div>
              ) : breakoutParticipantNames.length > 0 ? breakoutParticipantNames.map((name) => (
                <span key={name} className="rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-[12px] text-text-2">
                  {name}
                </span>
              )) : (
                <div className="text-[13px] text-text-3/60">No participants were prefilled from this room.</div>
              )}
            </div>
            <div className="mt-3 text-[12px] leading-relaxed text-text-3/72">
              This breakout uses the room&apos;s current participants and default facilitator so you can start quickly from the chat context.
            </div>
          </div>
        ) : (
          <div>
            <div className="text-[11px] font-700 uppercase tracking-[0.12em] text-text-3/55">Participants</div>
            <div className="mt-2 flex max-h-[180px] flex-wrap gap-2 overflow-y-auto rounded-[14px] border border-white/[0.06] bg-white/[0.03] p-3">
              {loading ? (
                <div className="text-[13px] text-text-3/60">Loading options…</div>
              ) : agentOptions.map((agent) => {
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
        )}

        {!breakoutMode && selectedTemplate && (
          <div className="rounded-[16px] border border-white/[0.06] bg-white/[0.03] p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="text-[14px] font-700 text-text">{selectedTemplate.name}</div>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-700 uppercase tracking-[0.12em] ${
                selectedTemplate.builtIn
                  ? 'border-white/[0.08] bg-white/[0.04] text-text-3/75'
                  : 'border-sky-500/20 bg-sky-500/10 text-sky-200'
              }`}>
                {selectedTemplate.builtIn ? 'built in' : 'custom'}
              </span>
            </div>
            <div className="mt-2 text-[12px] leading-relaxed text-text-3/72">{selectedTemplate.description}</div>
            {!!selectedTemplate.steps?.length && (
              <div className="mt-3 flex flex-wrap gap-2">
                {selectedTemplate.steps.map((step) => (
                  <span key={step.id} className="rounded-full border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-[11px] text-text-3">
                    {step.label}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {!breakoutMode && (
          <details
            open={advancedOpen}
            onToggle={(event) => setAdvancedOpen((event.currentTarget as HTMLDetailsElement).open)}
            className="rounded-[16px] border border-white/[0.06] bg-white/[0.03] p-4"
          >
            <summary className="cursor-pointer list-none text-[12px] font-700 uppercase tracking-[0.12em] text-text-2">
              Advanced
            </summary>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <input
                value={form.roundLimit}
                onChange={(event) => setForm((current) => ({ ...current, roundLimit: event.target.value }))}
                placeholder="Round limit"
                className="rounded-[12px] border border-white/[0.06] bg-black/20 px-3 py-2.5 text-[14px] text-text outline-none placeholder:text-text-3/35"
              />
              <input
                value={form.decisionMode}
                onChange={(event) => setForm((current) => ({ ...current, decisionMode: event.target.value }))}
                placeholder="Decision mode"
                className="rounded-[12px] border border-white/[0.06] bg-black/20 px-3 py-2.5 text-[14px] text-text outline-none placeholder:text-text-3/35"
              />

              {allowContextSelection && (
                <>
                  <select
                    value={form.parentChatroomId}
                    onChange={(event) => setForm((current) => ({ ...current, parentChatroomId: event.target.value }))}
                    className="rounded-[12px] border border-white/[0.06] bg-black/20 px-3 py-2.5 text-[14px] text-text outline-none"
                  >
                    <option value="">No parent chatroom</option>
                    {Object.values(chatrooms).map((chatroom) => (
                      <option key={chatroom.id} value={chatroom.id}>{chatroom.name}</option>
                    ))}
                  </select>
                  <select
                    value={form.taskId}
                    onChange={(event) => setForm((current) => ({ ...current, taskId: event.target.value }))}
                    className="rounded-[12px] border border-white/[0.06] bg-black/20 px-3 py-2.5 text-[14px] text-text outline-none"
                  >
                    <option value="">No linked task</option>
                    {Object.values(tasks).map((task) => (
                      <option key={task.id} value={task.id}>{task.title}</option>
                    ))}
                  </select>
                </>
              )}

              <label className="flex items-center gap-2 rounded-[12px] border border-white/[0.06] bg-black/20 px-3 py-2.5 text-[13px] text-text-2">
                <input
                  type="checkbox"
                  checked={form.autoStart}
                  onChange={(event) => setForm((current) => ({ ...current, autoStart: event.target.checked }))}
                />
                Start immediately
              </label>
              <label className="flex items-center gap-2 rounded-[12px] border border-white/[0.06] bg-black/20 px-3 py-2.5 text-[13px] text-text-2">
                <input
                  type="checkbox"
                  checked={form.createTranscript}
                  onChange={(event) => setForm((current) => ({ ...current, createTranscript: event.target.checked }))}
                />
                Create temporary transcript
              </label>
            </div>
          </details>
        )}
      </div>

      <div className="mt-8">
        <SheetFooter
          onCancel={onClose}
          onSave={() => void handleSave()}
          saveLabel={saving ? 'Starting…' : breakoutMode ? 'Start breakout' : 'Start structured session'}
          saveDisabled={saving || loading}
        />
      </div>
    </BottomSheet>
  )
}
