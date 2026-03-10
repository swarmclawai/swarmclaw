'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/app/api-client'
import { useWs } from '@/hooks/use-ws'
import { StatusDot } from '@/components/ui/status-dot'

interface DaemonStatus {
  running: boolean
  schedulerActive: boolean
  queueLength: number
  lastProcessed: number | null
  nextScheduled: number | null
}

export function DaemonIndicator() {
  const [status, setStatus] = useState<DaemonStatus | null>(null)

  const fetchStatus = async () => {
    try {
      const data = await api<DaemonStatus>('GET', '/daemon')
      setStatus(data)
    } catch { /* ignore */ }
  }

  useEffect(() => { fetchStatus() }, [])
  useWs('daemon', fetchStatus, 30_000)

  const toggle = async () => {
    try {
      await api('POST', '/daemon', { action: status?.running ? 'stop' : 'start' })
      fetchStatus()
    } catch { /* ignore */ }
  }

  if (!status) return null

  return (
    <button
      onClick={toggle}
      className="flex items-center gap-2 px-3 py-2 rounded-[10px] bg-surface border border-white/[0.06] hover:bg-surface-2 transition-colors cursor-pointer w-full"
      title={status.running ? 'Daemon running — click to pause' : 'Daemon paused — click to start'}
    >
      <StatusDot status={status.running ? 'online' : 'idle'} glow={status.running} />
      <span className="text-[12px] font-600 text-text-2 flex-1 text-left">
        Daemon
      </span>
      {status.queueLength > 0 && (
        <span className="text-[10px] font-mono text-amber-400/70">
          {status.queueLength} queued
        </span>
      )}
    </button>
  )
}
