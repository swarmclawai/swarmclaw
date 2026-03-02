'use client'

import { useState, useEffect } from 'react'
import { api } from '@/lib/api-client'

export const FILE_PATH_RE = /^(\/[\w./-]+\.\w{1,10})$/
export const DIR_PATH_RE = /^(\/[\w./-]+)\/?$/
const PREVIEWABLE_EXT = /\.(html?|svg|css|js|jsx|ts|tsx|json|md|txt|py|sh)$/i
const SERVEABLE_EXT = /\.(html?|svg|css|js|jsx|ts|tsx)$/i

export function FilePathChip({ filePath }: { filePath: string }) {
  const canPreview = PREVIEWABLE_EXT.test(filePath)
  const canServe = SERVEABLE_EXT.test(filePath)
  const serveUrl = `/api/files/serve?path=${encodeURIComponent(filePath)}`

  const [serverState, setServerState] = useState<{
    running: boolean; url?: string; loading: boolean; type?: string; framework?: string
  }>({ running: false, loading: false })

  // Check if a server is already running for this path on mount
  useEffect(() => {
    if (!canServe) return
    api<{ running: boolean; url?: string; type?: string }>('POST', '/preview-server', { action: 'status', path: filePath })
      .then((res) => { if (res.running) setServerState({ running: true, url: res.url, type: res.type, loading: false }) })
      .catch((err: unknown) => console.error('Dev server check failed:', err))
  }, [filePath, canServe])

  const handleStartServer = async () => {
    setServerState((s) => ({ ...s, loading: true }))
    try {
      const res = await api<{ running: boolean; url?: string; type?: string; framework?: string }>('POST', '/preview-server', { action: 'start', path: filePath })
      setServerState({ running: res.running, url: res.url, type: res.type, framework: res.framework, loading: false })
    } catch {
      setServerState((s) => ({ ...s, loading: false }))
    }
  }

  const handleStopServer = async () => {
    setServerState((s) => ({ ...s, loading: true }))
    try {
      await api('POST', '/preview-server', { action: 'stop', path: filePath })
      setServerState({ running: false, loading: false })
    } catch {
      setServerState((s) => ({ ...s, loading: false }))
    }
  }

  const frameworkLabel = serverState.framework
    ? serverState.framework.charAt(0).toUpperCase() + serverState.framework.slice(1)
    : null

  const isDir = !PREVIEWABLE_EXT.test(filePath) && !filePath.includes('.')

  const handleReveal = () => {
    api('POST', '/files/open', { path: filePath }).catch(() => { /* best-effort */ })
  }

  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-[8px] bg-white/[0.06] border border-white/[0.08] font-mono text-[13px]">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-text-3/50 shrink-0">
        {isDir ? (
          <><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></>
        ) : (
          <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></>
        )}
      </svg>
      <span className="text-sky-400">{filePath}</span>
      <button
        onClick={handleReveal}
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[4px] bg-white/[0.06] hover:bg-white/[0.10] text-[10px] font-600 text-text-3 hover:text-text-2 border-none transition-colors cursor-pointer"
        title={isDir ? 'Open folder' : 'Reveal in file manager'}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
          <polyline points="15 3 21 3 21 9" />
          <line x1="10" y1="14" x2="21" y2="3" />
        </svg>
        {isDir ? 'Open' : 'Reveal'}
      </button>
      {canPreview && !serverState.running && (
        <a
          href={serveUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[4px] bg-white/[0.06] hover:bg-white/[0.10] text-[10px] font-600 text-text-3 hover:text-text-2 no-underline transition-colors cursor-pointer"
          title="Open file"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
          Open
        </a>
      )}
      {canServe && !serverState.running && (
        <button
          onClick={handleStartServer}
          disabled={serverState.loading}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[4px] bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400 text-[10px] font-600 border-none cursor-pointer transition-colors disabled:opacity-50"
          title="Start preview server — auto-detects npm projects (React, Next, Vite, etc.) and runs the dev command"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
          {serverState.loading ? 'Starting...' : 'Serve'}
        </button>
      )}
      {canServe && serverState.running && (
        <>
          {frameworkLabel && (
            <span className="px-1.5 py-0.5 rounded-[4px] bg-indigo-500/15 text-indigo-300 text-[9px] font-700 uppercase tracking-wider">
              {frameworkLabel}
            </span>
          )}
          {serverState.type === 'npm' && (
            <span className="px-1.5 py-0.5 rounded-[4px] bg-amber-500/15 text-amber-300 text-[9px] font-700 uppercase tracking-wider">
              npm
            </span>
          )}
          <a
            href={serverState.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[4px] bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400 text-[10px] font-600 no-underline transition-colors"
            title="Open preview server"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" style={{ animation: 'pulse 2s ease infinite' }} />
            {serverState.url}
          </a>
          <button
            onClick={handleStopServer}
            disabled={serverState.loading}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[4px] bg-red-500/15 hover:bg-red-500/25 text-red-400 text-[10px] font-600 border-none cursor-pointer transition-colors disabled:opacity-50"
            title="Stop preview server"
          >
            <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor">
              <rect x="4" y="4" width="16" height="16" rx="2" />
            </svg>
            Stop
          </button>
        </>
      )}
    </span>
  )
}
