import {
  deleteApproval as deleteStoredApproval,
  loadApprovals as loadStoredApprovals,
  upsertApproval as upsertStoredApproval,
} from '@/lib/server/storage'
import { createRecordRepository } from '@/lib/server/persistence/repository-utils'
import type { ApprovalRequest } from '@/types'

export const approvalRepository = createRecordRepository<ApprovalRequest>(
  'approvals',
  {
    get(id) {
      return loadStoredApprovals()[id] || null
    },
    list() {
      return loadStoredApprovals() as Record<string, ApprovalRequest>
    },
    upsert(id, value) {
      upsertStoredApproval(id, value)
    },
    delete(id) {
      deleteStoredApproval(id)
    },
  },
)

export const loadApprovals = () => approvalRepository.list()
export const loadApproval = (id: string) => approvalRepository.get(id)
export const upsertApproval = (id: string, value: ApprovalRequest | Record<string, unknown>) => approvalRepository.upsert(id, value as ApprovalRequest)
export const deleteApproval = (id: string) => approvalRepository.delete(id)
