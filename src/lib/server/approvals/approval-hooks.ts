import type { ApprovalRequest } from '@/types'
import { logActivity } from '@/lib/server/activity/activity-log'
import { log } from '@/lib/server/logger'

const TAG = 'approval-hooks'

type ApprovalHookHandler = (request: ApprovalRequest) => void

const approvalHandlers: Partial<Record<string, ApprovalHookHandler>> = {
  agent_create: onAgentCreateDecided,
  budget_change: onBudgetChangeDecided,
  delegation_enable: onDelegationEnableDecided,
}

/**
 * Dispatch lifecycle hooks when an approval decision is made.
 * Called from submitDecision() after the approval is persisted.
 */
export function onApprovalDecision(request: ApprovalRequest): void {
  const handler = approvalHandlers[request.category]
  if (!handler) return
  try {
    handler(request)
  } catch (err) {
    log.error(TAG, `Error in approval hook for ${request.category}: ${err}`)
  }
}

function onAgentCreateDecided(request: ApprovalRequest): void {
  if (request.status !== 'approved') return
  const pendingConfig = request.data.pendingAgentConfig as Record<string, unknown> | undefined
  if (!pendingConfig) return

  // Dynamically import to avoid circular dependency
  import('@/lib/server/agents/agent-service').then(({ createAgent }) => {
    const agent = createAgent({ body: pendingConfig })
    logActivity({
      entityType: 'agent',
      entityId: agent.id,
      action: 'created',
      actor: 'system',
      summary: `Agent "${agent.name}" created after approval ${request.id}`,
      detail: { approvalId: request.id },
    })
  }).catch((err) => {
    log.error(TAG, `Failed to create agent after approval: ${err}`)
  })
}

function onBudgetChangeDecided(request: ApprovalRequest): void {
  if (request.status !== 'approved') return
  const agentId = request.data.agentId as string | undefined
  const budgetChanges = request.data.budgetChanges as Record<string, unknown> | undefined
  if (!agentId || !budgetChanges) return

  import('@/lib/server/agents/agent-service').then(({ updateAgent }) => {
    updateAgent(agentId, budgetChanges)
    logActivity({
      entityType: 'budget',
      entityId: agentId,
      action: 'configured',
      actor: 'system',
      summary: `Budget updated for agent after approval ${request.id}`,
      detail: { approvalId: request.id, budgetChanges },
    })
  }).catch((err) => {
    log.error(TAG, `Failed to apply budget change after approval: ${err}`)
  })
}

function onDelegationEnableDecided(request: ApprovalRequest): void {
  if (request.status !== 'approved') return
  const agentId = request.data.agentId as string | undefined
  if (!agentId) return

  import('@/lib/server/agents/agent-service').then(({ updateAgent }) => {
    updateAgent(agentId, { delegationEnabled: true })
  }).catch((err) => {
    log.error(TAG, `Failed to enable delegation after approval: ${err}`)
  })
}
