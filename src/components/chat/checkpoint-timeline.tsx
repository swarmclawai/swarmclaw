'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/api-client'
import { useAppStore } from '@/stores/use-app-store'
import { toast } from 'sonner'

interface Checkpoint {
  checkpointId: string
  parentCheckpointId?: string
  metadata: Record<string, unknown>
  createdAt: number
  values?: Record<string, unknown>
}

interface Props {
  sessionId: string
}

export function CheckpointTimeline({ sessionId }: Props) {
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([])
  const [loading, setLoading] = useState(true)
  const [restoringId, setRestoringId] = useState<string | null>(null)
  const loadSessions = useAppStore((s) => s.loadSessions)

  const load = async () => {
    setLoading(true)
    try {
      const data = await api<Checkpoint[]>('GET', `/chats/${sessionId}/checkpoints`)
      setCheckpoints(data)
    } catch (err) {
      console.error('Failed to load checkpoints', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const handleRestore = async (checkpoint: Checkpoint) => {
    if (!confirm('Restore session to this point? This will delete all subsequent history.')) return
    
    setRestoringId(checkpoint.checkpointId)
    try {
      await api('POST', `/chats/${sessionId}/restore`, {
        checkpointId: checkpoint.checkpointId,
        timestamp: checkpoint.createdAt
      })
      toast.success('Session restored successfully')
      await loadSessions()
      await load()
    } catch (err) {
      toast.error('Failed to restore session')
      console.error(err)
    } finally {
      setRestoringId(null)
    }
  }

  if (loading) {
    return <div className="p-8 text-center text-text-3 text-[13px]">Retrieving history...</div>
  }

  if (checkpoints.length === 0) {
    return (
      <div className="p-8 text-center">
        <p className="text-text-3 text-[13px]">No checkpoints found for this chat.</p>
        <p className="text-[11px] text-text-3/50 mt-1">Only LangGraph-orchestrated chats support time travel.</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 p-5">
      {checkpoints.map((cp, i) => (
        <div 
          key={cp.checkpointId}
          className="group relative flex flex-col gap-2 p-3 rounded-[12px] border border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04] transition-all"
        >
          <div className="flex items-center justify-between">
            <div className="flex flex-col">
              <span className="text-[11px] font-700 text-accent-bright uppercase tracking-wider">
                {i === 0 ? 'Current State' : `Point ${checkpoints.length - i}`}
              </span>
              <span className="text-[10px] text-text-3 font-mono">
                {new Date(cp.createdAt).toLocaleString()}
              </span>
            </div>
            {i > 0 && (
              <button
                onClick={() => handleRestore(cp)}
                disabled={!!restoringId}
                className="px-3 py-1 rounded-[6px] bg-accent-soft text-accent-bright text-[11px] font-600 border-none cursor-pointer hover:brightness-110 disabled:opacity-50"
              >
                {restoringId === cp.checkpointId ? 'Restoring...' : 'Restore here'}
              </button>
            )}
          </div>
          
          {cp.values && Array.isArray(cp.values.messages) && cp.values.messages.length > 0 && (
            <div className="mt-1 p-2 rounded-[8px] bg-black/20 text-[11px] text-text-3 line-clamp-2 italic">
              Last message: {String((cp.values.messages[cp.values.messages.length - 1] as Record<string, unknown>)?.content ?? 'Empty state')}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
