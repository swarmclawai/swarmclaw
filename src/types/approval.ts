// --- Approvals ---

export type ApprovalCategory =
  | 'tool_access'
  | 'extension_scaffold'
  | 'extension_install'
  | 'task_tool'
  | 'human_loop'
  | 'connector_sender'
  | 'agent_create'
  | 'budget_change'
  | 'delegation_enable'

export interface ApprovalRequest {
  id: string
  category: ApprovalCategory
  agentId?: string | null
  sessionId?: string | null
  taskId?: string | null
  title: string
  description?: string
  data: Record<string, unknown>
  createdAt: number
  updatedAt: number
  status: 'pending' | 'approved' | 'rejected'
}

export type Approvals = Record<string, ApprovalRequest>
