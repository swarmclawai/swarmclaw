import { execSync } from 'node:child_process'
import path from 'node:path'
import type { ApprovalRequest, GuardianCheckpoint } from '@/types'
import { loadApprovals } from '@/lib/server/approvals/approval-repository'
import {
  loadGuardianCheckpoints,
  patchGuardianCheckpoint,
  upsertGuardianCheckpoint,
} from '@/lib/server/agents/guardian-checkpoint-repository'
import { requestApproval } from '@/lib/server/approvals'
import { errorMessage } from '@/lib/shared-utils'
import { genId } from '@/lib/id'

function now(): number {
  return Date.now()
}

function trimString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function runGit(cwd: string, args: string[]): string {
  return execSync(`git ${args.join(' ')}`, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function resolveGitRoot(cwd: string): string | null {
  try {
    return runGit(cwd, ['rev-parse', '--show-toplevel']) || null
  } catch {
    return null
  }
}

function readCheckpointMetadata(cwd: string): { root: string; head: string; branch: string | null; status: string } | null {
  const root = resolveGitRoot(cwd)
  if (!root) return null
  try {
    return {
      root,
      head: runGit(root, ['rev-parse', 'HEAD']),
      branch: trimString(runGit(root, ['branch', '--show-current'])),
      status: runGit(root, ['status', '--porcelain=v1', '--untracked-files=all']),
    }
  } catch {
    return null
  }
}

function checkpointsForCwd(cwd: string): GuardianCheckpoint[] {
  return Object.values(loadGuardianCheckpoints())
    .filter((checkpoint) => checkpoint.cwd === cwd)
    .sort((left, right) => right.createdAt - left.createdAt)
}

function findPendingRestoreApproval(approvalId?: string | null): ApprovalRequest | null {
  const approvals = loadApprovals() as Record<string, ApprovalRequest>
  return Object.values(approvals).find((approval) => {
    if (approval.category !== 'human_loop' || approval.status !== 'pending') return false
    if (approval.data?.kind !== 'guardian_restore') return false
    if (approvalId && approval.id !== approvalId) return false
    return true
  }) || null
}

export function captureGuardianCheckpoint(cwd: string, createdBy = 'task'): {
  ok: boolean
  checkpoint?: GuardianCheckpoint
  reason?: string
} {
  const metadata = readCheckpointMetadata(cwd)
  if (!metadata) {
    return {
      ok: false,
      reason: 'Workspace is not git-backed. Automatic recovery stays advisory only.',
    }
  }

  const checkpoint: GuardianCheckpoint = {
    id: genId(10),
    cwd: metadata.root,
    head: metadata.head,
    branch: metadata.branch,
    status: metadata.status,
    createdAt: now(),
    createdBy,
    approvalId: null,
    restorePreparedAt: null,
    restoredAt: null,
  }
  upsertGuardianCheckpoint(checkpoint.id, checkpoint)
  return { ok: true, checkpoint }
}

export function prepareGuardianRecovery(params: {
  cwd: string
  reason: string
  requester?: string | null
}): {
  ok: boolean
  checkpoint?: GuardianCheckpoint
  approval?: ApprovalRequest
  reason?: string
} {
  const metadata = readCheckpointMetadata(params.cwd)
  if (!metadata) {
    return {
      ok: false,
      reason: 'Workspace is not git-backed. Recovery request recorded without mutating files.',
    }
  }

  const root = metadata.root
  const checkpoint = checkpointsForCwd(root)[0] || captureGuardianCheckpoint(root, 'guardian-prep').checkpoint
  if (!checkpoint) {
    return {
      ok: false,
      reason: 'Unable to capture or locate a checkpoint for this workspace.',
    }
  }

  const existing = findPendingRestoreApproval(checkpoint.approvalId || null)
  if (existing) {
    patchGuardianCheckpoint(checkpoint.id, (current) => current ? {
      ...current,
      approvalId: existing.id,
      restorePreparedAt: current.restorePreparedAt || now(),
    } : current)
    return {
      ok: true,
      checkpoint: {
        ...checkpoint,
        approvalId: existing.id,
        restorePreparedAt: checkpoint.restorePreparedAt || now(),
      },
      approval: existing,
    }
  }

  const approval = requestApproval({
    category: 'human_loop',
    title: 'Restore workspace checkpoint',
    description: `Restore ${path.basename(root)} to checkpoint ${checkpoint.head.slice(0, 12)} after a failed autonomous run.`,
    data: {
      kind: 'guardian_restore',
      cwd: root,
      checkpointId: checkpoint.id,
      head: checkpoint.head,
      branch: checkpoint.branch,
      status: checkpoint.status,
      reason: params.reason,
      requester: trimString(params.requester) || 'guardian',
    },
  })

  const updated = patchGuardianCheckpoint(checkpoint.id, (current) => current ? {
    ...current,
    approvalId: approval.id,
    restorePreparedAt: now(),
  } : current)

  return {
    ok: true,
    checkpoint: updated || { ...checkpoint, approvalId: approval.id, restorePreparedAt: now() },
    approval,
  }
}

export function restoreGuardianCheckpoint(approvalId: string): { ok: boolean; checkpoint?: GuardianCheckpoint; reason?: string } {
  const approvals = loadApprovals() as Record<string, ApprovalRequest>
  const approval = approvals[approvalId]
  if (!approval || approval.category !== 'human_loop' || approval.data?.kind !== 'guardian_restore') {
    return { ok: false, reason: `Approval "${approvalId}" not found.` }
  }
  if (approval.status !== 'approved') {
    return { ok: false, reason: `Approval "${approvalId}" is not approved yet.` }
  }

  const checkpointId = trimString(approval.data.checkpointId)
  const cwd = trimString(approval.data.cwd)
  const head = trimString(approval.data.head)
  if (!checkpointId || !cwd || !head) {
    return { ok: false, reason: 'Approval is missing checkpoint metadata.' }
  }

  const metadata = readCheckpointMetadata(cwd)
  if (!metadata) {
    return { ok: false, reason: 'Workspace is not git-backed anymore.' }
  }

  try {
    runGit(metadata.root, ['reset', '--hard', head])
    runGit(metadata.root, ['clean', '-fd'])
    const updated = patchGuardianCheckpoint(checkpointId, (current) => current ? {
      ...current,
      restoredAt: now(),
    } : current)
    return {
      ok: true,
      checkpoint: updated || checkpointsForCwd(metadata.root).find((entry) => entry.id === checkpointId),
    }
  } catch (err: unknown) {
    return {
      ok: false,
      reason: `Git restore failed: ${errorMessage(err)}`,
    }
  }
}
