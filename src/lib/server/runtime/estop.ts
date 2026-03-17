import type { ApprovalRequest, EstopState } from '@/types'
import { loadApprovals, upsertApproval } from '@/lib/server/approvals/approval-repository'
import { loadPersistedEstopState, savePersistedEstopState } from '@/lib/server/runtime/estop-repository'
import { loadSettings } from '@/lib/server/settings/settings-repository'
import { requestApproval } from '@/lib/server/approvals'

const DEFAULT_ESTOP_STATE: EstopState = {
  level: 'none',
  reason: null,
  engagedAt: null,
  engagedBy: null,
  resumeApprovalId: null,
  updatedAt: 0,
}

function now(): number {
  return Date.now()
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function normalizeEstopState(input: EstopState | null | undefined): EstopState {
  if (!input) return { ...DEFAULT_ESTOP_STATE, updatedAt: now() }
  const level = input.level === 'autonomy' || input.level === 'all' ? input.level : 'none'
  return {
    level,
    reason: normalizeString(input.reason),
    engagedAt: level === 'none'
      ? null
      : (typeof input.engagedAt === 'number' && Number.isFinite(input.engagedAt) ? Math.trunc(input.engagedAt) : now()),
    engagedBy: level === 'none' ? null : normalizeString(input.engagedBy),
    resumeApprovalId: normalizeString(input.resumeApprovalId),
    updatedAt: typeof input.updatedAt === 'number' && Number.isFinite(input.updatedAt) ? Math.trunc(input.updatedAt) : now(),
  }
}

export function loadEstopState(): EstopState {
  return normalizeEstopState(loadPersistedEstopState())
}

export function saveEstopState(state: EstopState): EstopState {
  const normalized = normalizeEstopState(state)
  savePersistedEstopState(normalized)
  return normalized
}

export function engageEstop(params: {
  level: 'autonomy' | 'all'
  reason?: string | null
  engagedBy?: string | null
}): EstopState {
  return saveEstopState({
    level: params.level,
    reason: normalizeString(params.reason),
    engagedAt: now(),
    engagedBy: normalizeString(params.engagedBy) || 'system',
    resumeApprovalId: null,
    updatedAt: now(),
  })
}

function isEstopResumeApproval(approval: ApprovalRequest | null | undefined, approvalId?: string | null): approval is ApprovalRequest {
  if (!approval || approval.category !== 'human_loop') return false
  if (approval.data?.kind !== 'estop_resume') return false
  if (approvalId && approval.id !== approvalId) return false
  return true
}

function isPendingEstopResumeApproval(approval: ApprovalRequest | null | undefined, approvalId?: string | null): approval is ApprovalRequest {
  if (!isEstopResumeApproval(approval, approvalId)) return false
  if (approval.status !== 'pending') return false
  return true
}

export function areEstopResumeApprovalsEnabled(): boolean {
  return loadSettings().autonomyResumeApprovalsEnabled === true
}

export function findEstopResumeApproval(approvalId?: string | null): ApprovalRequest | null {
  const approvals = loadApprovals() as Record<string, ApprovalRequest>
  if (approvalId) {
    const approval = approvals[approvalId]
    return isEstopResumeApproval(approval, approvalId) ? approval : null
  }
  return Object.values(approvals).find((approval) => isEstopResumeApproval(approval)) || null
}

export function findPendingEstopResumeApproval(approvalId?: string | null): ApprovalRequest | null {
  const approvals = loadApprovals() as Record<string, ApprovalRequest>
  if (approvalId) {
    const approval = approvals[approvalId]
    return isPendingEstopResumeApproval(approval, approvalId) ? approval : null
  }
  return Object.values(approvals).find((approval) => isPendingEstopResumeApproval(approval)) || null
}

function clearPendingEstopResumeApproval(approvalId?: string | null): void {
  const approval = findPendingEstopResumeApproval(approvalId)
  if (!approval) return
  upsertApproval(approval.id, {
    ...approval,
    status: 'rejected',
    updatedAt: now(),
  })
}

export function requestEstopResumeApproval(params?: {
  requester?: string | null
  question?: string | null
}): { state: EstopState; approval: ApprovalRequest | null } {
  const state = loadEstopState()
  if (state.level === 'none') return { state, approval: null }
  const existing = findPendingEstopResumeApproval(state.resumeApprovalId || null)
  if (existing) {
    if (state.resumeApprovalId !== existing.id) {
      return {
        state: saveEstopState({ ...state, resumeApprovalId: existing.id, updatedAt: now() }),
        approval: existing,
      }
    }
    return { state, approval: existing }
  }

  const approval = requestApproval({
    category: 'human_loop',
    title: `Resume ${state.level} estop`,
    description: normalizeString(params?.question)
      || `Resume execution after ${state.level} estop. Review the reason and confirm before resuming.`,
    data: {
      kind: 'estop_resume',
      estopLevel: state.level,
      reason: state.reason,
      requester: normalizeString(params?.requester) || 'system',
    },
  })

  return {
    state: saveEstopState({
      ...state,
      resumeApprovalId: approval.id,
      updatedAt: now(),
    }),
    approval,
  }
}

export function resumeEstop(params?: {
  approvalId?: string | null
  bypassApproval?: boolean
}): EstopState {
  const state = loadEstopState()
  if (state.level === 'none') return state

  if (params?.bypassApproval) {
    clearPendingEstopResumeApproval(state.resumeApprovalId)
    return saveEstopState({
      level: 'none',
      reason: null,
      engagedAt: null,
      engagedBy: null,
      resumeApprovalId: null,
      updatedAt: now(),
    })
  }

  const normalizedApprovalId = normalizeString(params?.approvalId) || state.resumeApprovalId
  if (!normalizedApprovalId) {
    throw new Error('A resume approval is required before clearing estop.')
  }

  const approvals = loadApprovals() as Record<string, ApprovalRequest>
  const approval = approvals[normalizedApprovalId]
  if (!approval || approval.data?.kind !== 'estop_resume') {
    throw new Error(`Resume approval "${normalizedApprovalId}" not found.`)
  }
  if (approval.status !== 'approved') {
    throw new Error(`Resume approval "${normalizedApprovalId}" is not approved yet.`)
  }

  return saveEstopState({
    level: 'none',
    reason: null,
    engagedAt: null,
    engagedBy: null,
    resumeApprovalId: approval.id,
    updatedAt: now(),
  })
}

export function isAutonomyEstopEngaged(): boolean {
  const level = loadEstopState().level
  return level === 'autonomy' || level === 'all'
}

export function isAllEstopEngaged(): boolean {
  return loadEstopState().level === 'all'
}
