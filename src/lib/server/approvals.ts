import { genId } from '@/lib/id'
import { loadApprovals, upsertApproval } from './storage'
import type { ApprovalCategory, ApprovalRequest } from '@/types'
import { notify } from './ws-hub'
import { requestHeartbeatNow } from '@/lib/server/runtime/heartbeat-wake'
import { enqueueSystemEvent } from '@/lib/server/runtime/system-events'
import { enqueueSessionRun } from '@/lib/server/runtime/session-run-manager'

function trimToString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function buildApprovalDecisionResumeText(request: ApprovalRequest, approved: boolean): string {
  const statusLabel = approved ? 'approved' : 'rejected'
  const lines = [`[Approval ${statusLabel}] ${request.title}`]
  const description = trimToString(request.description)
  if (description) lines.push(`Details: ${description}`)
  lines.push(`Approval id: ${request.id}`)
  lines.push(approved
    ? 'Continue the work that was blocked on this human-loop decision.'
    : 'The requested action was rejected. Adjust the plan and continue safely.')
  return lines.join('\n')
}

function buildApprovalDecisionResumeMessage(request: ApprovalRequest, approved: boolean): string {
  const lines = [
    'APPROVAL_DECISION_EVENT',
    `Approval id: ${request.id}`,
    `Category: ${request.category}`,
    `Status: ${approved ? 'approved' : 'rejected'}`,
    `Title: ${request.title}`,
  ]

  const description = trimToString(request.description)
  if (description) lines.push(`Details: ${description}`)

  const question = trimToString(request.data.question)
  if (question) lines.push(`Question: ${question}`)

  if (approved) {
    lines.push('Resume the blocked task now instead of re-requesting the same approval.')
  } else {
    lines.push('Do not retry the exact rejected approval request unless the requested action materially changes.')
  }

  return lines.join('\n')
}

function wakeForApprovalDecision(request: ApprovalRequest, approved: boolean): void {
  const reason = approved ? 'approval-approved' : 'approval-rejected'
  if (request.sessionId) {
    enqueueSystemEvent(
      request.sessionId,
      buildApprovalDecisionResumeText(request, approved),
      `approval:${request.id}:${approved ? 'approved' : 'rejected'}`,
    )
    enqueueSessionRun({
      sessionId: request.sessionId,
      message: buildApprovalDecisionResumeMessage(request, approved),
      internal: true,
      source: 'approval-decision',
      mode: 'collect',
      dedupeKey: `approval-decision:${request.id}`,
    })
    return
  }

  if (request.agentId) {
    requestHeartbeatNow({
      agentId: request.agentId,
      eventId: `approval:${request.id}:${approved ? 'approved' : 'rejected'}`,
      reason,
      source: `approval:${request.category}`,
      resumeMessage: buildApprovalDecisionResumeText(request, approved),
      detail: request.title || request.category,
    })
  }
}

export function requestApproval(params: {
  category: ApprovalCategory
  title: string
  description?: string
  data: Record<string, unknown>
  agentId?: string | null
  sessionId?: string | null
  taskId?: string | null
}): ApprovalRequest {
  const id = genId(8)
  const now = Date.now()
  const request: ApprovalRequest = {
    id,
    ...params,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  }

  upsertApproval(id, request)
  notify('approvals')
  return request
}

async function persistApprovalDecision(request: ApprovalRequest, approved: boolean): Promise<ApprovalRequest> {
  request.status = approved ? 'approved' : 'rejected'
  request.updatedAt = Date.now()
  upsertApproval(request.id, request)

  notify('approvals')
  import('@/lib/server/runtime/watch-jobs')
    .then(({ triggerApprovalWatchJobs }) => {
      triggerApprovalWatchJobs({
        approvalId: request.id,
        status: approved ? 'approved' : 'rejected',
        title: request.title,
        description: request.description,
      })
    })
    .catch(() => {
      // best-effort trigger only
    })
  if (request.sessionId) notify(`session:${request.sessionId}`)
  return request
}

export async function submitDecision(id: string, approved: boolean): Promise<ApprovalRequest> {
  const approvals = loadApprovals() as Record<string, ApprovalRequest>
  const request = approvals[id]
  if (!request) throw new Error('Approval request not found')
  if (request.status === (approved ? 'approved' : 'rejected')) return request
  if (request.status !== 'pending') return request
  const updated = await persistApprovalDecision(request, approved)
  wakeForApprovalDecision(updated, approved)
  return updated
}

export function listPendingApprovals(category?: ApprovalCategory): ApprovalRequest[] {
  const approvals = loadApprovals() as Record<string, ApprovalRequest>
  return Object.values(approvals)
    .filter((request) => request.status === 'pending' && (!category || request.category === category))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}
