'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { api } from '@/lib/api-client'
import { useAppStore } from '@/stores/use-app-store'
import { BottomSheet } from '@/components/shared/bottom-sheet'

interface LogEntry {
  time: string
  level: string
  tag: string
  message: string
  data?: string
}

const LEVEL_COLORS: Record<string, string> = {
  ERROR: 'text-red-400',
  WARN: 'text-amber-400',
  INFO: 'text-blue-400',
  DEBUG: 'text-text-3',
}

const LEVEL_BG: Record<string, string> = {
  ERROR: 'bg-red-500/10',
  WARN: 'bg-amber-500/10',
  INFO: 'bg-blue-500/10',
  DEBUG: 'bg-white/[0.02]',
}

export function LogList() {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [levelFilter, setLevelFilter] = useState<string[]>([])
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [selected, setSelected] = useState<LogEntry | null>(null)
  const [creatingTask, setCreatingTask] = useState(false)
  const [taskAgentId, setTaskAgentId] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  const agents = useAppStore((s) => s.agents)
  const loadAgents = useAppStore((s) => s.loadAgents)
  const loadTasks = useAppStore((s) => s.loadTasks)

  const fetchLogs = useCallback(async () => {
    try {
      const params = new URLSearchParams({ lines: '300' })
      if (levelFilter.length) params.set('level', levelFilter.join(','))
      if (search) params.set('search', search)
      const res = await api('GET', `/logs?${params}`) as { entries: LogEntry[]; total: number }
      setEntries(res.entries || [])
      setTotal(res.total || 0)
    } catch (err) {
      console.error('Failed to fetch logs:', err)
    } finally {
      setLoading(false)
    }
  }, [levelFilter, search])

  useEffect(() => {
    fetchLogs()
    loadAgents()
  }, [fetchLogs])

  // Auto-refresh every 3s
  useEffect(() => {
    if (!autoRefresh) return
    const id = setInterval(fetchLogs, 3000)
    return () => clearInterval(id)
  }, [autoRefresh, fetchLogs])

  const clearLogs = async () => {
    try {
      await api('DELETE', '/logs')
      setEntries([])
      setTotal(0)
    } catch (err) {
      console.error('Failed to clear logs:', err)
    }
  }

  const toggleLevel = (level: string) => {
    setLevelFilter((prev) =>
      prev.includes(level) ? prev.filter((l) => l !== level) : [...prev, level]
    )
  }

  const formatTime = (iso: string) => {
    if (!iso) return ''
    try {
      const d = new Date(iso)
      return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    } catch {
      return iso.slice(11, 19)
    }
  }

  const formatFullTime = (iso: string) => {
    if (!iso) return ''
    try {
      const d = new Date(iso)
      return d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'medium' })
    } catch {
      return iso
    }
  }

  const handleCreateTask = async () => {
    if (!selected) return
    setCreatingTask(true)
    try {
      const title = `[${selected.level}] ${selected.tag}: ${selected.message}`.slice(0, 120)
      const description = [
        `**Log Level:** ${selected.level}`,
        `**Source:** ${selected.tag}`,
        `**Time:** ${selected.time}`,
        `**Message:** ${selected.message}`,
        selected.data ? `\n**Data:**\n\`\`\`\n${selected.data}\n\`\`\`` : '',
      ].filter(Boolean).join('\n')

      await api('POST', '/tasks', {
        title,
        description,
        status: 'backlog',
        agentId: taskAgentId || undefined,
      })
      await loadTasks()
      setSelected(null)
    } catch (err) {
      console.error('Failed to create task:', err)
    } finally {
      setCreatingTask(false)
    }
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-3 text-[13px]">
        Loading logs...
      </div>
    )
  }

  const agentList = Object.values(agents)

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Controls */}
      <div className="px-4 py-2 space-y-2 shrink-0">
        {/* Search */}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search logs..."
          className="w-full px-3 py-2 rounded-[8px] bg-white/[0.04] border border-white/[0.06] text-[12px] text-text placeholder:text-text-3/50 outline-none focus:border-accent/30"
        />
        {/* Level filters + controls */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {['ERROR', 'WARN', 'INFO', 'DEBUG'].map((level) => (
            <button
              key={level}
              onClick={() => toggleLevel(level)}
              className={`px-2 py-1 rounded-[6px] text-[10px] font-700 uppercase tracking-wider cursor-pointer transition-all border-none ${
                levelFilter.length === 0 || levelFilter.includes(level)
                  ? `${LEVEL_BG[level]} ${LEVEL_COLORS[level]}`
                  : 'bg-white/[0.02] text-text-3/70'
              }`}
            >
              {level}
            </button>
          ))}
          <div className="flex-1" />
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`px-2 py-1 rounded-[6px] text-[10px] font-600 cursor-pointer transition-all border-none ${
              autoRefresh ? 'bg-green-500/10 text-green-400' : 'bg-white/[0.04] text-text-3'
            }`}
            title={autoRefresh ? 'Auto-refresh ON' : 'Auto-refresh OFF'}
          >
            {autoRefresh ? 'LIVE' : 'PAUSED'}
          </button>
          <button
            onClick={clearLogs}
            className="px-2 py-1 rounded-[6px] text-[10px] font-600 cursor-pointer transition-all border-none bg-white/[0.04] text-text-3 hover:text-red-400 hover:bg-red-500/10"
            title="Clear all logs"
          >
            CLEAR
          </button>
        </div>
      </div>

      {/* Total count */}
      <div className="px-4 py-1 text-[10px] text-text-3/60">
        {entries.length} of {total} entries
      </div>

      {/* Log entries */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-2 pb-20">
        {entries.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-text-3 text-[12px]">
            No log entries
          </div>
        ) : (
          entries.map((entry, i) => (
            <button
              key={i}
              onClick={() => { setSelected(entry); setTaskAgentId('') }}
              className={`w-full text-left px-2 py-1.5 rounded-[6px] hover:bg-white/[0.03] transition-colors cursor-pointer bg-transparent border-none block
                ${entry.level === 'ERROR' ? 'hover:bg-red-500/[0.04]' : ''}`}
            >
              <div className="flex items-start gap-2">
                <span className="text-[10px] text-text-3/50 font-mono shrink-0 mt-[1px] w-[58px]">
                  {formatTime(entry.time)}
                </span>
                <span className={`text-[9px] font-700 uppercase tracking-wider shrink-0 mt-[2px] w-[36px] ${LEVEL_COLORS[entry.level] || 'text-text-3'}`}>
                  {entry.level}
                </span>
                <span className="text-[10px] font-600 text-accent/60 shrink-0 mt-[1px]">
                  {entry.tag}
                </span>
                <span className="text-[11px] text-text-2 truncate flex-1">
                  {entry.message}
                </span>
                {/* Arrow indicator */}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-text-3/50 shrink-0 mt-[2px]">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </div>
            </button>
          ))
        )}
      </div>

      {/* Log Detail Sheet */}
      <BottomSheet open={!!selected} onClose={() => setSelected(null)}>
        {selected && (
          <>
            <div className="mb-8">
              <div className="flex items-center gap-3 mb-3">
                <span className={`text-[11px] font-700 uppercase tracking-wider px-2.5 py-1 rounded-[6px] ${LEVEL_BG[selected.level]} ${LEVEL_COLORS[selected.level]}`}>
                  {selected.level}
                </span>
                <span className="text-[12px] font-600 text-accent/80 font-mono">{selected.tag}</span>
              </div>
              <h2 className="font-display text-[22px] font-700 tracking-[-0.02em] mb-2 leading-snug">
                {selected.message}
              </h2>
              <p className="text-[12px] text-text-3/60 font-mono">{formatFullTime(selected.time)}</p>
            </div>

            {/* Data payload */}
            {selected.data && (
              <div className="mb-8">
                <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Details</label>
                <pre className="text-[11px] text-text-3/80 font-mono whitespace-pre-wrap break-all bg-white/[0.02] rounded-[12px] p-4 max-h-[300px] overflow-auto border border-white/[0.04]">
                  {selected.data}
                </pre>
              </div>
            )}

            {/* Create as Task */}
            <div className="pt-4 border-t border-white/[0.04]">
              <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">
                Create as Task
              </label>
              <p className="text-[12px] text-text-3/60 mb-3">
                Turn this log entry into a task and optionally assign it to an agent to investigate.
              </p>
              <div className="flex gap-2">
                <select
                  value={taskAgentId}
                  onChange={(e) => setTaskAgentId(e.target.value)}
                  className="flex-1 px-4 py-3 rounded-[14px] border border-white/[0.08] bg-surface text-text text-[14px] outline-none appearance-none cursor-pointer"
                  style={{ fontFamily: 'inherit' }}
                >
                  <option value="">Unassigned</option>
                  {agentList.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
                <button
                  onClick={handleCreateTask}
                  disabled={creatingTask}
                  className="px-5 py-3 rounded-[14px] border-none bg-[#6366F1] text-white text-[14px] font-600
                    cursor-pointer active:scale-[0.97] disabled:opacity-40 transition-all
                    shadow-[0_4px_20px_rgba(99,102,241,0.25)] hover:brightness-110 shrink-0"
                  style={{ fontFamily: 'inherit' }}
                >
                  {creatingTask ? 'Creating...' : 'Create Task'}
                </button>
              </div>
            </div>
          </>
        )}
      </BottomSheet>
    </div>
  )
}
