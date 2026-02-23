'use client'

import { useEffect, useState, useCallback } from 'react'

const CHECK_INTERVAL = 5 * 60_000 // 5 minutes

type VersionInfo = {
  localSha: string
  remoteSha: string
  updateAvailable: boolean
  behindBy: number
}

type UpdateState = 'idle' | 'updating' | 'done' | 'error'

export function UpdateBanner() {
  const [version, setVersion] = useState<VersionInfo | null>(null)
  const [updateState, setUpdateState] = useState<UpdateState>('idle')
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState('')

  const checkVersion = useCallback(async () => {
    try {
      const res = await fetch('/api/version')
      if (!res.ok) return
      const data: VersionInfo = await res.json()
      setVersion(data)
    } catch {
      // silently fail — no network or server issue
    }
  }, [])

  useEffect(() => {
    checkVersion()
    const id = setInterval(checkVersion, CHECK_INTERVAL)
    return () => clearInterval(id)
  }, [checkVersion])

  const handleUpdate = async () => {
    setUpdateState('updating')
    setErrorMsg('')
    try {
      const res = await fetch('/api/version/update', { method: 'POST' })
      const data = await res.json()
      if (data.success) {
        setUpdateState('done')
      } else {
        setUpdateState('error')
        setErrorMsg(data.error || 'Update failed')
      }
    } catch {
      setUpdateState('error')
      setErrorMsg('Network error')
    }
  }

  const handleDismiss = () => {
    if (version) setDismissed(version.remoteSha)
  }

  // Don't show if no update, or user dismissed this specific remote SHA
  if (!version?.updateAvailable) return null
  if (dismissed === version.remoteSha && updateState === 'idle') return null

  return (
    <div className="px-4 py-1.5 border-b border-white/[0.04] text-[10px] flex items-center gap-2 shrink-0 bg-primary/5">
      {updateState === 'idle' && (
        <>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-primary shrink-0">
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
          <span className="text-text-3 flex-1 min-w-0 truncate">
            <span className="text-primary font-600">{version.behindBy}</span> update{version.behindBy !== 1 ? 's' : ''} available
          </span>
          <button
            onClick={handleUpdate}
            className="text-[10px] font-600 text-primary hover:text-white bg-primary/20 hover:bg-primary/30 px-2 py-0.5 rounded-[6px] border-none cursor-pointer transition-all shrink-0"
            style={{ fontFamily: 'inherit' }}
          >
            Update
          </button>
          <button
            onClick={handleDismiss}
            className="text-text-3/50 hover:text-text-3 bg-transparent border-none cursor-pointer p-0 shrink-0 transition-colors"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </>
      )}

      {updateState === 'updating' && (
        <>
          <span className="w-3 h-3 border-[1.5px] border-primary/30 border-t-primary rounded-full shrink-0"
            style={{ animation: 'spin 0.8s linear infinite' }} />
          <span className="text-text-3">Updating...</span>
        </>
      )}

      {updateState === 'done' && (
        <>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-success shrink-0">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <span className="text-text-3 flex-1">Updated! Restart to apply.</span>
        </>
      )}

      {updateState === 'error' && (
        <>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-red-400 shrink-0">
            <circle cx="12" cy="12" r="10" />
            <line x1="15" y1="9" x2="9" y2="15" />
            <line x1="9" y1="9" x2="15" y2="15" />
          </svg>
          <span className="text-red-400/80 flex-1 truncate">{errorMsg}</span>
          <button
            onClick={() => setUpdateState('idle')}
            className="text-[10px] font-600 text-text-3 hover:text-text bg-white/[0.04] px-2 py-0.5 rounded-[6px] border-none cursor-pointer transition-all shrink-0"
            style={{ fontFamily: 'inherit' }}
          >
            Retry
          </button>
        </>
      )}
    </div>
  )
}
