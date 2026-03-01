'use client'

import { create } from 'zustand'
import type { PendingExecApproval, ExecApprovalDecision } from '@/types'
import { api } from '@/lib/api-client'

interface ApprovalState {
  approvals: Record<string, PendingExecApproval>
  resolvedIds: Set<string>
  addApproval: (approval: PendingExecApproval) => void
  removeApproval: (id: string) => void
  resolveApproval: (id: string, decision: ExecApprovalDecision) => Promise<void>
  pruneExpired: () => void
  loadApprovals: () => Promise<void>
}

export const useApprovalStore = create<ApprovalState>((set) => ({
  approvals: {},
  resolvedIds: new Set<string>(),

  addApproval: (approval) => {
    set((s) => ({ approvals: { ...s.approvals, [approval.id]: approval } }))
  },

  removeApproval: (id) => {
    set((s) => {
      const next = { ...s.approvals }
      delete next[id]
      return { approvals: next }
    })
  },

  resolveApproval: async (id, decision) => {
    // Mark as resolving
    set((s) => {
      const approval = s.approvals[id]
      if (!approval) return s
      return { approvals: { ...s.approvals, [id]: { ...approval, resolving: true, error: undefined } } }
    })

    try {
      await api('POST', '/openclaw/approvals', { id, decision })
      // Remove on success
      set((s) => {
        const next = { ...s.approvals }
        delete next[id]
        return { approvals: next }
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      const isConflict = message.includes('409') || message.includes('Already resolved')
      if (isConflict) {
        // Another session already resolved this — treat as success
        set((s) => {
          const next = { ...s.approvals }
          delete next[id]
          const nextResolved = new Set(s.resolvedIds)
          nextResolved.add(id)
          return { approvals: next, resolvedIds: nextResolved }
        })
      } else {
        set((s) => {
          const approval = s.approvals[id]
          if (!approval) return s
          return { approvals: { ...s.approvals, [id]: { ...approval, resolving: false, error: message } } }
        })
      }
    }
  },

  pruneExpired: () => {
    const now = Date.now()
    set((s) => {
      const next: Record<string, PendingExecApproval> = {}
      for (const [id, a] of Object.entries(s.approvals)) {
        if (a.expiresAtMs > now && !s.resolvedIds.has(id)) next[id] = a
      }
      return { approvals: next }
    })
  },

  loadApprovals: async () => {
    try {
      const result = await api<PendingExecApproval[]>('GET', '/openclaw/approvals')
      const approvals: Record<string, PendingExecApproval> = {}
      for (const a of result) approvals[a.id] = a
      set({ approvals, resolvedIds: new Set<string>() })
    } catch {
      // ignore — gateway may be offline
    }
  },
}))
