'use client'

import { useEffect, useState, useCallback } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { useNavigate } from '@/lib/app/navigation'
import { getMemory, updateMemory, deleteMemory } from '@/lib/memory'
import { deriveMemoryScope, getMemoryScopeLabel, getMemoryTier } from '@/lib/memory-presentation'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { ConfirmDialog } from '@/components/shared/confirm-dialog'
import type { MemoryEntry } from '@/types'

const CATEGORIES = ['note', 'fact', 'preference', 'finding', 'learning', 'general']

export function MemoryDetail() {
  const selectedId = useAppStore((s) => s.selectedMemoryId)
  const setSelectedId = useAppStore((s) => s.setSelectedMemoryId)
  const triggerRefresh = useAppStore((s) => s.triggerMemoryRefresh)
  const agents = useAppStore((s) => s.agents)
  const sessions = useAppStore((s) => s.sessions)
  const setCurrentAgent = useAppStore((s) => s.setCurrentAgent)
  const navigateTo = useNavigate()

  const [entry, setEntry] = useState<MemoryEntry | null>(null)
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [category, setCategory] = useState('note')
  const [editTier, setEditTier] = useState<'working' | 'durable' | 'archive'>('durable')
  const [editAgentId, setEditAgentId] = useState<string | null>(null)
  const [editSharedWith, setEditSharedWith] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [linkedTitles, setLinkedTitles] = useState<Record<string, string>>({})
  const [refsExpanded, setRefsExpanded] = useState(false)
  const [metaExpanded, setMetaExpanded] = useState(false)

  // Load memory entry when selection changes
  useEffect(() => {
    if (!selectedId) {
      setEntry(null)
      setEditing(false)
      return
    }

    let cancelled = false
    getMemory(selectedId, { depth: 0 })
      .then((found) => {
        if (cancelled || !found) return

        const resolved = Array.isArray(found)
          ? found.find((item) => item.id === selectedId) || found[0] || null
          : found

        if (!resolved) return

        setEntry(resolved)
        setTitle(resolved.title)
        setContent(resolved.content)
        setCategory(resolved.category || 'note')
        setEditTier(getMemoryTier(resolved))
        setEditAgentId(resolved.agentId || null)
        setEditSharedWith(resolved.sharedWith || [])
        setEditing(false)
        setRefsExpanded(false)
        setMetaExpanded(false)
      })
      .catch((err) => console.error('Memory operation failed:', err))

    return () => {
      cancelled = true
    }
  }, [selectedId])

  // Resolve linked memory titles
  useEffect(() => {
    if (!entry?.linkedMemoryIds?.length) {
      setLinkedTitles({})
      return
    }
    let cancelled = false
    Promise.all(
      entry.linkedMemoryIds.map((id) =>
        getMemory(id, { depth: 0 }).then((m) => {
          const resolved = Array.isArray(m) ? m[0] : m
          return [id, resolved?.title || id] as const
        }).catch(() => [id, id] as const),
      ),
    ).then((pairs) => {
      if (cancelled) return
      setLinkedTitles(Object.fromEntries(pairs))
    })
    return () => { cancelled = true }
  }, [entry?.linkedMemoryIds])

  const handleSave = useCallback(async () => {
    if (!entry) return
    setSaving(true)
    try {
      const updated = await updateMemory(entry.id, {
        title,
        content,
        category,
        agentId: editAgentId,
        sharedWith: editSharedWith.length ? editSharedWith : undefined,
        metadata: {
          ...(entry.metadata || {}),
          tier: editTier,
          scope: editAgentId ? 'agent' : 'global',
          visibility: editAgentId ? (editSharedWith.length ? 'shared' : 'private') : 'global',
        },
      })
      setEntry(updated)
      setEditing(false)
      triggerRefresh()
    } catch { /* ignore */ }
    setSaving(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry, title, content, category, editAgentId, editSharedWith])

  const handleDelete = useCallback(async () => {
    if (!entry) return
    await deleteMemory(entry.id)
    setSelectedId(null)
    triggerRefresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry])

  const handleTogglePin = useCallback(async () => {
    if (!entry) return
    try {
      const updated = await updateMemory(entry.id, { pinned: !entry.pinned })
      setEntry(updated)
      triggerRefresh()
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry])

  const handleNavigateToSession = useCallback(() => {
    if (!entry?.sessionId) return
    const agentId = sessions[entry.sessionId]?.agentId
    if (agentId) void setCurrentAgent(agentId)
    navigateTo('agents')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry, sessions])

  if (!entry) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 text-text-3 p-8 text-center">
        <div className="w-14 h-14 rounded-[16px] bg-white/[0.03] flex items-center justify-center mb-2">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-text-3/60">
            <ellipse cx="12" cy="5" rx="9" ry="3" />
            <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
            <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
          </svg>
        </div>
        <p className="font-display text-[17px] font-600 text-text-2">Select a Memory</p>
        <p className="text-[13px] text-text-3/70 max-w-[300px]">
          Choose a memory from the list to view its details
        </p>
      </div>
    )
  }

  const agentName = entry.agentId ? (agents[entry.agentId]?.name || entry.agentId) : null
  const sessionName = entry.sessionId ? (sessions[entry.sessionId]?.name || entry.sessionId) : null
  const scope = deriveMemoryScope(entry)
  const tier = getMemoryTier(entry)
  const imagePath = entry.image?.path || entry.imagePath || null
  const imageUrl = imagePath
    ? imagePath.startsWith('data/memory-images/')
      ? `/api/memory-images/${imagePath.split('/').pop()}`
      : imagePath
    : null

  const inputClass = "w-full px-4 py-3 rounded-[12px] border border-white/[0.06] bg-white/[0.02] text-text outline-none transition-all duration-200 placeholder:text-text-3/70 focus:border-accent-bright/20 focus:bg-white/[0.03]"
  const refs = entry.references || []
  const showRefsCollapse = refs.length > 3

  return (
    <div className="flex-1 flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="shrink-0 px-6 py-4 border-b border-white/[0.04] flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5">
            <span className="shrink-0 text-[10px] font-700 uppercase tracking-wider text-accent-bright/70 bg-accent-soft px-2 py-0.5 rounded-[6px]">
              {entry.category || 'note'}
            </span>
            <span className="shrink-0 text-[10px] font-700 uppercase tracking-wider text-text-3/70 bg-white/[0.04] px-2 py-0.5 rounded-[6px]">
              {getMemoryScopeLabel(scope)}
            </span>
            <span className={`shrink-0 text-[10px] font-700 uppercase tracking-wider px-2 py-0.5 rounded-[6px] ${
              tier === 'working'
                ? 'bg-amber-400/10 text-amber-300'
                : tier === 'archive'
                  ? 'bg-sky-400/10 text-sky-300'
                  : 'bg-emerald-400/10 text-emerald-300'
            }`}>
              {tier}
            </span>
            {!editing && (
              <h2 className="font-display text-[16px] font-700 truncate tracking-[-0.02em]">{entry.title || 'Untitled'}</h2>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1">
            {agentName && (
              <span className="text-[11px] text-text-3/50 flex items-center gap-1">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
                {agentName}
              </span>
            )}
            {sessionName && (
              <button
                onClick={handleNavigateToSession}
                className="text-[11px] text-accent-bright/50 hover:text-accent-bright flex items-center gap-1 bg-transparent border-none cursor-pointer p-0 transition-colors"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                {sessionName}
              </button>
            )}
            <span className="text-[10px] text-text-3/50 font-mono tabular-nums">
              {new Date(entry.createdAt).toLocaleString()}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Pin/unpin toggle */}
          <button
            onClick={handleTogglePin}
            className={`p-2 rounded-[8px] cursor-pointer transition-all bg-transparent border-none
              ${entry.pinned ? 'text-amber-400 hover:text-amber-300' : 'text-text-3/40 hover:text-amber-400/70'}`}
            title={entry.pinned ? 'Unpin memory' : 'Pin memory (always preloaded)'}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill={entry.pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 17v5" /><path d="M9 2h6l-1.5 6H16l1 4H7l1-4h1.5z" />
            </svg>
          </button>
          {editing ? (
            <>
              <button
                onClick={() => {
                  setTitle(entry.title)
                  setContent(entry.content)
                  setCategory(entry.category || 'note')
                  setEditTier(getMemoryTier(entry))
                  setEditAgentId(entry.agentId || null)
                  setEditSharedWith(entry.sharedWith || [])
                  setEditing(false)
                }}
                className="px-3 py-2 rounded-[10px] border border-white/[0.08] bg-transparent text-text-2 text-[12px] font-600 cursor-pointer hover:bg-surface-2 transition-all"
                style={{ fontFamily: 'inherit' }}
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-4 py-2 rounded-[10px] bg-accent-bright text-white text-[12px] font-600
                  cursor-pointer border-none transition-all hover:brightness-110 active:scale-[0.97]
                  disabled:opacity-50 shadow-[0_2px_10px_rgba(99,102,241,0.2)]"
                style={{ fontFamily: 'inherit' }}
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            </>
          ) : (
            <button
              onClick={() => setEditing(true)}
              className="px-3 py-2 rounded-[10px] border border-white/[0.08] bg-transparent text-text-2 text-[12px] font-600 cursor-pointer hover:bg-white/[0.04] transition-all flex items-center gap-1.5"
              style={{ fontFamily: 'inherit' }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
              Edit
            </button>
          )}
          <button
            onClick={() => setConfirmDelete(true)}
            className="p-2 rounded-[8px] text-text-3/70 hover:text-red-400 hover:bg-red-400/[0.06]
              cursor-pointer transition-all bg-transparent border-none"
            title="Delete memory"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
            </svg>
          </button>
        </div>
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="max-w-[720px] space-y-5">
          {editing ? (
            <>
              {/* Title input */}
              <div>
                <label className="block text-[11px] font-600 text-text-3/60 uppercase tracking-[0.06em] mb-2">Title</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className={`${inputClass} text-[15px] font-600`}
                  style={{ fontFamily: 'inherit' }}
                  placeholder="Memory title"
                />
              </div>

              {/* Category picker */}
              <div>
                <label className="block text-[11px] font-600 text-text-3/60 uppercase tracking-[0.06em] mb-2">Category</label>
                <div className="flex gap-1.5 flex-wrap">
                  {CATEGORIES.map((c) => (
                    <button
                      key={c}
                      onClick={() => setCategory(c)}
                      className={`px-3 py-1.5 rounded-[8px] text-[11px] font-600 capitalize cursor-pointer transition-all border-none
                        ${category === c
                          ? 'bg-accent-soft text-accent-bright'
                          : 'bg-white/[0.03] text-text-3 hover:text-text-2 hover:bg-white/[0.05]'}`}
                      style={{ fontFamily: 'inherit' }}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-600 text-text-3/60 uppercase tracking-[0.06em] mb-2">Tier</label>
                <select
                  value={editTier}
                  onChange={(e) => setEditTier(e.target.value as typeof editTier)}
                  className={inputClass}
                  style={{ fontFamily: 'inherit' }}
                >
                  <option value="working">Working</option>
                  <option value="durable">Durable</option>
                  <option value="archive">Archive</option>
                </select>
              </div>

              {/* Agent assignment */}
              <div>
                <label className="block text-[11px] font-600 text-text-3/60 uppercase tracking-[0.06em] mb-2">Visibility</label>
                <div className="flex gap-1.5 flex-wrap">
                  <button
                    onClick={() => setEditAgentId(null)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] text-[11px] font-600 cursor-pointer transition-all border
                      ${!editAgentId
                        ? 'bg-accent-soft border-accent-bright/20 text-accent-bright'
                        : 'bg-white/[0.02] border-white/[0.06] text-text-3 hover:text-text-2 hover:bg-white/[0.04]'}`}
                    style={{ fontFamily: 'inherit' }}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={!editAgentId ? 'text-accent-bright' : 'text-text-3/60'}>
                      <circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" />
                      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                    </svg>
                    Global
                  </button>
                  {Object.values(agents).sort((a, b) => a.name.localeCompare(b.name)).map((agent) => (
                    <button
                      key={agent.id}
                      onClick={() => setEditAgentId(agent.id)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] text-[11px] font-600 cursor-pointer transition-all border
                        ${editAgentId === agent.id
                          ? 'bg-accent-soft border-accent-bright/20 text-accent-bright'
                          : 'bg-white/[0.02] border-white/[0.06] text-text-3 hover:text-text-2 hover:bg-white/[0.04]'}`}
                      style={{ fontFamily: 'inherit' }}
                    >
                      <AgentAvatar seed={agent.avatarSeed || null} avatarUrl={agent.avatarUrl} name={agent.name} size={16} />
                      <span className="truncate max-w-[100px]">{agent.name}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Shared with */}
              {editAgentId && (
                <div>
                  <label className="block text-[11px] font-600 text-text-3/60 uppercase tracking-[0.06em] mb-2">Share with</label>
                  <div className="flex gap-1.5 flex-wrap">
                    {Object.values(agents)
                      .filter((a) => a.id !== editAgentId)
                      .sort((a, b) => a.name.localeCompare(b.name))
                      .map((agent) => {
                        const isShared = editSharedWith.includes(agent.id)
                        return (
                          <button
                            key={agent.id}
                            onClick={() => {
                              setEditSharedWith(isShared
                                ? editSharedWith.filter((id) => id !== agent.id)
                                : [...editSharedWith, agent.id])
                            }}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] text-[11px] font-600 cursor-pointer transition-all border
                              ${isShared
                                ? 'bg-accent-soft border-accent-bright/20 text-accent-bright'
                                : 'bg-white/[0.02] border-white/[0.06] text-text-3 hover:text-text-2 hover:bg-white/[0.04]'}`}
                            style={{ fontFamily: 'inherit' }}
                          >
                            <AgentAvatar seed={agent.avatarSeed || null} avatarUrl={agent.avatarUrl} name={agent.name} size={16} />
                            <span className="truncate max-w-[100px]">{agent.name}</span>
                          </button>
                        )
                      })}
                  </div>
                  {editSharedWith.length === 0 && (
                    <p className="text-[10px] text-text-3/40 mt-1.5">No agents selected — only the assigned agent can access this memory</p>
                  )}
                </div>
              )}

              {/* Content textarea */}
              <div>
                <label className="block text-[11px] font-600 text-text-3/60 uppercase tracking-[0.06em] mb-2">Content</label>
                <textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="Memory content..."
                  rows={12}
                  className={`${inputClass} text-[14px] resize-y min-h-[200px] leading-relaxed`}
                  style={{ fontFamily: 'inherit' }}
                />
              </div>
            </>
          ) : (
            <>
              {/* Read-mode: Title as h1 */}
              <h1 className="font-display text-[22px] font-700 tracking-[-0.02em] text-text leading-tight">
                {entry.title || 'Untitled'}
              </h1>

              {/* Read-mode: Content as readable prose */}
              <div className="text-[15px] leading-[1.7] text-text-2 whitespace-pre-wrap break-words">
                {entry.content || '(empty)'}
              </div>

              {/* Shared with (read mode) */}
              {entry.sharedWith && entry.sharedWith.length > 0 && (
                <div>
                  <label className="block text-[11px] font-600 text-text-3/60 uppercase tracking-[0.06em] mb-2">Shared with</label>
                  <div className="flex gap-1.5 flex-wrap">
                    {entry.sharedWith.map((aid) => {
                      const a = agents[aid]
                      return (
                        <span key={aid} className="flex items-center gap-1.5 px-2.5 py-1 rounded-[8px] bg-white/[0.03] text-[11px] text-text-3">
                          <AgentAvatar seed={a?.avatarSeed || null} avatarUrl={a?.avatarUrl} name={a?.name || aid} size={16} />
                          {a?.name || aid}
                        </span>
                      )
                    })}
                  </div>
                </div>
              )}
            </>
          )}

          {/* Image (both modes) */}
          {imageUrl && (
            <div>
              {editing && <label className="block text-[11px] font-600 text-text-3/60 uppercase tracking-[0.06em] mb-2">Image</label>}
              <a href={imageUrl} target="_blank" rel="noreferrer" className="inline-block rounded-[12px] overflow-hidden border border-white/[0.08]">
                <img src={imageUrl} alt={entry.title} className="max-w-[600px] w-full max-h-[400px] object-cover block" />
              </a>
            </div>
          )}

          {/* Linked Memories */}
          {entry.linkedMemoryIds?.length ? (
            <div>
              <label className="block text-[11px] font-600 text-text-3/60 uppercase tracking-[0.06em] mb-2">Linked Memories</label>
              <div className="flex flex-col gap-1.5">
                {entry.linkedMemoryIds.map((id) => (
                  <button
                    key={id}
                    onClick={() => setSelectedId(id)}
                    className="flex items-center gap-2.5 px-3 py-2 rounded-[10px] bg-white/[0.02] border border-white/[0.06] hover:bg-white/[0.04] cursor-pointer transition-colors text-left w-full"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-accent-bright/60 shrink-0">
                      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                    </svg>
                    <span className="text-[13px] text-text-2 truncate">
                      {linkedTitles[id] || id}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {/* References (collapsible) */}
          {refs.length > 0 && (
            <div>
              <button
                onClick={() => setRefsExpanded(!refsExpanded)}
                className="flex items-center gap-1.5 text-[11px] font-600 text-text-3/60 uppercase tracking-[0.06em] mb-2 bg-transparent border-none cursor-pointer p-0 hover:text-text-3 transition-colors"
                style={{ fontFamily: 'inherit' }}
              >
                <svg
                  width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
                  className={`transition-transform ${refsExpanded || !showRefsCollapse ? 'rotate-90' : ''}`}
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
                References ({refs.length})
              </button>
              {(refsExpanded || !showRefsCollapse) && (
                <div className="space-y-2">
                  {refs.map((ref, idx) => (
                    <div key={`${ref.type}-${ref.path || ref.title || idx}`} className="text-[12px] rounded-[10px] border border-white/[0.06] bg-white/[0.02] px-3 py-2">
                      <div className="text-text-2/70">
                        <span className="uppercase text-[10px] tracking-[0.06em] mr-1">{ref.type}</span>
                        {ref.path || ref.title || '(no path)'}
                      </div>
                      {(ref.projectName || ref.projectRoot || ref.note || typeof ref.exists === 'boolean') && (
                        <div className="text-text-3/55 mt-1">
                          {ref.projectName ? `project: ${ref.projectName} ` : ''}
                          {ref.projectRoot ? `root: ${ref.projectRoot} ` : ''}
                          {typeof ref.exists === 'boolean' ? (ref.exists ? 'exists' : 'missing') : ''}
                          {ref.note ? ` — ${ref.note}` : ''}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Metadata (disclosure) */}
          <div className="pt-2">
            <button
              onClick={() => setMetaExpanded(!metaExpanded)}
              className="flex items-center gap-1.5 text-[11px] font-600 text-text-3/60 uppercase tracking-[0.06em] bg-transparent border-none cursor-pointer p-0 hover:text-text-3 transition-colors"
              style={{ fontFamily: 'inherit' }}
            >
              <svg
                width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
                className={`transition-transform ${metaExpanded ? 'rotate-90' : ''}`}
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
              Details
            </button>
            {metaExpanded && (
              <div className="mt-3 pt-3 border-t border-white/[0.04]">
                <div className="grid grid-cols-2 gap-4 text-[11px]">
                  <div>
                    <span className="text-text-3/70 block mb-1">ID</span>
                    <span className="text-text-3/60 font-mono">{entry.id}</span>
                  </div>
                  <div>
                    <span className="text-text-3/70 block mb-1">Created</span>
                    <span className="text-text-3/60 font-mono">{new Date(entry.createdAt).toLocaleString()}</span>
                  </div>
                  <div>
                    <span className="text-text-3/70 block mb-1">Updated</span>
                    <span className="text-text-3/60 font-mono">{new Date(entry.updatedAt).toLocaleString()}</span>
                  </div>
                  {entry.agentId && (
                    <div>
                      <span className="text-text-3/70 block mb-1">Owner</span>
                      <span className="text-text-3/60 font-mono">{agentName}</span>
                    </div>
                  )}
                  <div>
                    <span className="text-text-3/70 block mb-1">Scope</span>
                    <span className="text-text-3/60 font-mono">{getMemoryScopeLabel(scope)}</span>
                  </div>
                  <div>
                    <span className="text-text-3/70 block mb-1">Tier</span>
                    <span className="text-text-3/60 font-mono">{tier}</span>
                  </div>
                  {entry.sessionId && (
                    <div>
                      <span className="text-text-3/70 block mb-1">Chat</span>
                      <button
                        onClick={handleNavigateToSession}
                        className="text-accent-bright/60 hover:text-accent-bright font-mono bg-transparent border-none cursor-pointer p-0 text-[11px] transition-colors"
                      >
                        {sessionName}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete Memory"
        message={`Delete "${entry.title}"? This cannot be undone.`}
        confirmLabel="Delete"
        danger
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => { void handleDelete() }}
      />
    </div>
  )
}
