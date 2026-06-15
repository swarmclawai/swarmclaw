'use client'

import { useMemo, useState } from 'react'
import {
  useContinueWorkflowRunMutation,
  useCreateWorkflowBundleMutation,
  useCreateWorkflowPlanMutation,
  useWorkflowLedgerQuery,
} from '@/features/workflows/queries'
import type { WorkflowPlanDraft } from '@/types'

interface WorkflowLaunchPanelProps {
  selectedRunId: string | null
  onRunCreated: (runId: string) => void
}

function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

export function WorkflowLaunchPanel({ selectedRunId, onRunCreated }: WorkflowLaunchPanelProps) {
  const [goal, setGoal] = useState('')
  const [title, setTitle] = useState('')
  const [cwd, setCwd] = useState('')
  const [allowedScopes, setAllowedScopes] = useState('')
  const [reviewApproved, setReviewApproved] = useState(false)
  const [continueUntilDone, setContinueUntilDone] = useState(false)
  const [autoLaunch, setAutoLaunch] = useState(false)
  const [draft, setDraft] = useState<WorkflowPlanDraft | null>(null)
  const [continueSummary, setContinueSummary] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const planMutation = useCreateWorkflowPlanMutation()
  const bundleMutation = useCreateWorkflowBundleMutation()
  const continueMutation = useContinueWorkflowRunMutation()
  const ledgerQuery = useWorkflowLedgerQuery(selectedRunId, { enabled: Boolean(selectedRunId) })
  const ledger = ledgerQuery.data
  const taskCounts = useMemo(() => {
    const entries = ledger?.entries || []
    return {
      total: entries.length,
      completed: entries.filter((entry) => entry.status === 'completed').length,
      failed: entries.filter((entry) => entry.status === 'failed').length,
      active: entries.filter((entry) => entry.status === 'queued' || entry.status === 'running').length,
    }
  }, [ledger?.entries])

  async function draftPlan() {
    setError(null)
    setContinueSummary(null)
    try {
      const next = await planMutation.mutateAsync({
        title: title.trim() || undefined,
        goal: goal.trim(),
        cwd: cwd.trim() || null,
        allowedScopes: splitLines(allowedScopes),
      })
      setDraft(next)
      setReviewApproved(false)
      if (!title.trim()) setTitle(next.bundle.title)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to draft workflow plan.')
    }
  }

  async function launchDraft() {
    if (!draft) return
    setError(null)
    setContinueSummary(null)
    try {
      const bundle = {
        ...draft.bundle,
        queueImmediately: false,
        safetyProfile: {
          ...draft.bundle.safetyProfile,
          approvalRequired: true,
        },
      }
      const launched = await bundleMutation.mutateAsync(bundle)
      onRunCreated(launched.run.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to create workflow bundle.')
    }
  }

  async function continueRun() {
    if (!selectedRunId) return
    setError(null)
    const continuedLoopSpec = ledger?.loopSpec
      ? {
          ...ledger.loopSpec,
          continuationPolicy: autoLaunch ? 'safe_backlog_only' : 'draft_only',
        }
      : undefined
    try {
      const result = await continueMutation.mutateAsync({
        runId: selectedRunId,
        payload: {
          goal: goal.trim() || undefined,
          cwd: cwd.trim() || undefined,
          allowedScopes: splitLines(allowedScopes),
          continueUntilDone,
          autoLaunch,
          safetyProfile: autoLaunch
            ? {
                mode: 'read_only',
                approvalRequired: false,
                quarantine: false,
                allowedScopes: splitLines(allowedScopes),
              }
            : undefined,
          loopSpec: continuedLoopSpec,
        },
      })
      if (result.draft) {
        setDraft(result.draft)
        setReviewApproved(false)
      }
      if (result.launched?.run.id) onRunCreated(result.launched.run.id)
      const stopText = result.policy?.stopReasons?.length ? ` · ${result.policy.stopReasons.join('; ')}` : ''
      setContinueSummary(`${result.state}/${result.nextAction}: ${result.summary}${stopText}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to continue workflow run.')
    }
  }

  return (
    <section className="rounded-[24px] border border-white/[0.06] bg-white/[0.02] p-4 md:p-5">
      <div className="flex flex-col gap-5 xl:flex-row xl:items-start">
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-700 uppercase tracking-[0.12em] text-text-3/55">Workflow Bundles</div>
          <h2 className="mt-2 text-[22px] font-700 tracking-[-0.02em] text-text">Draft, Review, Launch</h2>
          <div className="mt-2 max-w-[820px] text-[13px] leading-relaxed text-text-3/70">
            Deterministic workflow bundles create normal task-board work linked to a Protocol run. Drafting creates no tasks; reviewed launch creates Backlog tasks first, then queueing happens from the task board.
          </div>

          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            <input
              data-testid="workflow-title-input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Workflow title"
              className="rounded-[12px] border border-white/[0.06] bg-white/[0.04] px-3 py-2.5 text-[14px] text-text outline-none placeholder:text-text-3/35"
            />
            <input
              data-testid="workflow-cwd-input"
              value={cwd}
              onChange={(event) => setCwd(event.target.value)}
              placeholder="Working directory"
              className="rounded-[12px] border border-white/[0.06] bg-white/[0.04] px-3 py-2.5 text-[14px] text-text outline-none placeholder:text-text-3/35"
            />
            <textarea
              data-testid="workflow-goal-input"
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder="Goal to turn into a workflow"
              rows={4}
              className="rounded-[12px] border border-white/[0.06] bg-white/[0.04] px-3 py-2.5 text-[14px] text-text outline-none placeholder:text-text-3/35 lg:col-span-2"
            />
            <textarea
              data-testid="workflow-allowed-scopes-input"
              value={allowedScopes}
              onChange={(event) => setAllowedScopes(event.target.value)}
              placeholder="Allowed scopes, one per line"
              rows={3}
              className="rounded-[12px] border border-white/[0.06] bg-white/[0.04] px-3 py-2.5 text-[13px] text-text outline-none placeholder:text-text-3/35 lg:col-span-2"
            />
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              data-testid="workflow-draft-plan"
              type="button"
              onClick={() => void draftPlan()}
              disabled={!goal.trim() || planMutation.isPending}
              className="rounded-[10px] bg-accent-bright px-3 py-2 text-[12px] font-700 text-black transition-all enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
            >
              {planMutation.isPending ? 'Drafting...' : 'Draft plan'}
            </button>
            <button
              data-testid="workflow-create-backlog"
              type="button"
              onClick={() => void launchDraft()}
              disabled={!draft || !reviewApproved || bundleMutation.isPending}
              className="rounded-[10px] border border-sky-500/20 bg-sky-500/10 px-3 py-2 text-[12px] font-700 text-sky-100 transition-all enabled:hover:bg-sky-500/16 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
            >
              {bundleMutation.isPending ? 'Creating...' : 'Create backlog tasks'}
            </button>
            <label className="flex items-center gap-2 rounded-[10px] border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-[12px] text-text-2">
              <input
                data-testid="workflow-review-approved"
                type="checkbox"
                checked={reviewApproved}
                disabled={!draft}
                onChange={(event) => setReviewApproved(event.target.checked)}
              />
              Reviewed and approved
            </label>
            {selectedRunId && (
              <button
                data-testid="workflow-continue-selected-run"
                type="button"
                onClick={() => void continueRun()}
                disabled={continueMutation.isPending}
                className="rounded-[10px] border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-[12px] font-700 text-text-2 transition-all hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
              >
                {continueMutation.isPending ? 'Checking...' : 'Continue selected run'}
              </button>
            )}
            <label className="flex items-center gap-2 rounded-[10px] border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-[12px] text-text-2">
              <input
                data-testid="workflow-continue-until-done"
                type="checkbox"
                checked={continueUntilDone}
                onChange={(event) => {
                  setContinueUntilDone(event.target.checked)
                  if (!event.target.checked) setAutoLaunch(false)
                }}
              />
              Continue until done
            </label>
            <label className="flex items-center gap-2 rounded-[10px] border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-[12px] text-text-2">
              <input
                data-testid="workflow-auto-create-safe-backlog"
                type="checkbox"
                checked={autoLaunch}
                disabled={!continueUntilDone}
                onChange={(event) => setAutoLaunch(event.target.checked)}
              />
              Auto-create safe backlog
            </label>
          </div>

          {(error || continueSummary) && (
            <div className={`mt-4 rounded-[14px] border px-4 py-3 text-[13px] ${
              error
                ? 'border-red-500/20 bg-red-500/10 text-red-200'
                : 'border-sky-500/20 bg-sky-500/10 text-sky-100'
            }`}>
              {error || continueSummary}
            </div>
          )}
        </div>

        <div className="w-full xl:max-w-[560px]">
          <div className="rounded-[18px] border border-white/[0.06] bg-white/[0.03] p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[11px] font-700 uppercase tracking-[0.12em] text-text-3/55">Draft</div>
                <div className="mt-1 text-[13px] text-text-3/70">
                  {draft ? `${draft.classification.replace(/_/g, ' ')} · ${draft.bundle.tasks.length} tasks · ${draft.routing.strategy.replace(/_/g, ' ')}` : 'No draft yet'}
                </div>
              </div>
              {draft && (
                <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 text-[10px] font-700 uppercase tracking-[0.12em] text-text-3">
                  draft only
                </span>
              )}
            </div>
            {draft && (
              <div className="mt-4 space-y-3">
                <div className="text-[13px] leading-relaxed text-text-2">{draft.summary}</div>
                <div className="rounded-[14px] border border-amber-500/15 bg-amber-500/10 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] font-700 uppercase tracking-[0.12em] text-amber-100/80">Review Gate</span>
                    <span className="rounded-full border border-amber-300/20 bg-amber-300/10 px-2 py-0.5 text-[10px] text-amber-50">
                      {draft.approvalGate.reviewerAgentId}
                    </span>
                  </div>
                  <div className="mt-2 text-[12px] leading-relaxed text-amber-50/80">
                    {draft.routing.reason}
                  </div>
                  <ul className="mt-2 space-y-1 text-[11px] leading-relaxed text-amber-50/70">
                    {draft.approvalGate.checklist.slice(0, 4).map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  <div className="rounded-[14px] border border-white/[0.06] bg-black/15 p-3">
                    <div className="text-[11px] font-700 uppercase tracking-[0.12em] text-text-3/55">Risks</div>
                    <ul className="mt-2 space-y-1 text-[11px] leading-relaxed text-text-3/70">
                      {draft.risks.slice(0, 4).map((risk) => (
                        <li key={risk}>{risk}</li>
                      ))}
                    </ul>
                  </div>
                  <div className="rounded-[14px] border border-white/[0.06] bg-black/15 p-3">
                    <div className="text-[11px] font-700 uppercase tracking-[0.12em] text-text-3/55">Quarantine</div>
                    <div className="mt-2 text-[11px] leading-relaxed text-text-3/70">
                      {draft.quarantine.enabled ? 'Enabled' : 'Off'} · {draft.quarantine.reason}
                    </div>
                    <div className="mt-2 text-[11px] leading-relaxed text-text-3/70">
                      Checkpoints: {draft.checkpoints.slice(0, 4).join(', ')}
                    </div>
                  </div>
                </div>
                {draft.bundle.loopSpec && (
                  <div className="rounded-[14px] border border-cyan-400/15 bg-cyan-400/10 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[11px] font-700 uppercase tracking-[0.12em] text-cyan-100/80">LoopSpec</span>
                      <span className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-2 py-0.5 text-[10px] text-cyan-50">
                        {draft.bundle.loopSpec.continuationPolicy.replace(/_/g, ' ')}
                      </span>
                    </div>
                    <div className="mt-2 space-y-1 text-[11px] leading-relaxed text-cyan-50/75">
                      <div>Invariant: {draft.bundle.loopSpec.invariant}</div>
                      <div>Progress: {draft.bundle.loopSpec.progressSignal}</div>
                      <div>Stuck: {draft.bundle.loopSpec.stuckSignal}</div>
                      <div>Stops: {draft.bundle.loopSpec.stopStates.join(', ')}</div>
                    </div>
                  </div>
                )}
                <div className="space-y-2">
                  {draft.bundle.tasks.map((task) => (
                    <div key={task.key} className="rounded-[14px] border border-white/[0.06] bg-black/15 p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[12px] font-700 text-text">{task.title}</span>
                        <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 text-[10px] text-text-3">{task.agentId}</span>
                      </div>
                      <div className="mt-1 text-[11px] text-text-3/65">
                        {task.expectedMarker || task.key}
                        {!!task.dependsOn?.length && ` · waits for ${task.dependsOn.join(', ')}`}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="mt-4 rounded-[18px] border border-white/[0.06] bg-white/[0.03] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-[11px] font-700 uppercase tracking-[0.12em] text-text-3/55">Selected Run Ledger</div>
                <div className="mt-1 text-[13px] text-text-3/70">
                  {ledger ? `${taskCounts.total} tasks · ${taskCounts.completed} done · ${taskCounts.active} active · ${taskCounts.failed} failed` : 'Select a workflow-backed run'}
                </div>
              </div>
            </div>
            <div className="mt-4 max-h-[320px] space-y-2 overflow-y-auto pr-1">
              {ledgerQuery.isFetching ? (
                <div className="text-[12px] text-text-3/65">Loading ledger...</div>
              ) : ledger?.entries.length ? (
                <>
                  {ledger.loopSpec && (
                    <div className="rounded-[14px] border border-cyan-400/15 bg-cyan-400/10 p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[11px] font-700 uppercase tracking-[0.12em] text-cyan-100/80">LoopSpec</span>
                        <span className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-2 py-0.5 text-[10px] text-cyan-50">
                          iteration {ledger.loopSpec.iteration}
                        </span>
                      </div>
                      <div className="mt-2 line-clamp-3 text-[11px] leading-relaxed text-cyan-50/75">
                        {ledger.loopSpec.invariant}
                      </div>
                    </div>
                  )}
                  {ledger.entries.map((entry) => (
                    <div key={entry.taskId} className="rounded-[14px] border border-white/[0.06] bg-black/15 p-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[12px] font-700 text-text">{entry.title}</div>
                          <div className="mt-1 text-[11px] text-text-3/65">{entry.agentId} · {entry.expectedMarker || entry.taskKey || entry.taskId}</div>
                        </div>
                        <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 text-[10px] font-700 uppercase tracking-[0.12em] text-text-3">
                          {entry.status}
                        </span>
                      </div>
                      {(entry.blockers?.length || entry.resultPreview) && (
                        <div className="mt-2 line-clamp-3 text-[11px] leading-relaxed text-text-3/70">
                          {entry.blockers?.length ? `Blocked by: ${entry.blockers.join(', ')}` : entry.resultPreview}
                        </div>
                      )}
                    </div>
                  ))}
                </>
              ) : (
                <div className="rounded-[14px] border border-white/[0.06] bg-white/[0.02] p-3 text-[12px] text-text-3/65">
                  No workflow ledger entries for the selected run.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
