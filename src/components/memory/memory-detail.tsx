'use client'

import { useEffect, useState, useCallback } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { getMemory, updateMemory, deleteMemory } from '@/lib/memory'
import type { MemoryEntry } from '@/types'

const CATEGORIES = ['note', 'fact', 'preference', 'finding', 'learning', 'general']

export function MemoryDetail() {
  const selectedId = useAppStore((s) => s.selectedMemoryId)
  const setSelectedId = useAppStore((s) => s.setSelectedMemoryId)
  const triggerRefresh = useAppStore((s) => s.triggerMemoryRefresh)
  const agents = useAppStore((s) => s.agents)
  const sessions = useAppStore((s) => s.sessions)
  const setCurrentSession = useAppStore((s) => s.setCurrentSession)
  const setActiveView = useAppStore((s) => s.setActiveView)

  const [entry, setEntry] = useState<MemoryEntry | null>(null)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [category, setCategory] = useState('note')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Load memory entry when selection changes
  useEffect(() => {
    if (!selectedId) { setEntry(null); return }
    getMemory(selectedId).then((found) => {
      if (!found || Array.isArray(found)) return
      setEntry(found)
      setTitle(found.title)
      setContent(found.content)
      setCategory(found.category || 'note')
      setDirty(false)
    }).catch(() => {})
  }, [selectedId])

  const handleSave = useCallback(async () => {
    if (!entry || !dirty) return
    setSaving(true)
    try {
      const updated = await updateMemory(entry.id, { title, content, category })
      setEntry(updated)
      setDirty(false)
      triggerRefresh()
    } catch { /* ignore */ }
    setSaving(false)
  }, [entry, title, content, category, dirty])

  const handleDelete = useCallback(async () => {
    if (!entry) return
    await deleteMemory(entry.id)
    setSelectedId(null)
    triggerRefresh()
  }, [entry])

  const handleNavigateToSession = useCallback(() => {
    if (!entry?.sessionId) return
    setActiveView('sessions')
    setCurrentSession(entry.sessionId)
  }, [entry])

  if (!entry) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 text-text-3 p-8 text-center">
        <div className="w-14 h-14 rounded-[16px] bg-white/[0.03] flex items-center justify-center mb-2">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-text-3/30">
            <ellipse cx="12" cy="5" rx="9" ry="3" />
            <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
            <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
          </svg>
        </div>
        <p className="font-display text-[17px] font-600 text-text-2">Memory</p>
        <p className="text-[13px] text-text-3/40 max-w-[300px]">
          Select a memory from the sidebar to view and edit it
        </p>
      </div>
    )
  }

  const agentName = entry.agentId ? (agents[entry.agentId]?.name || entry.agentId) : null
  const sessionName = entry.sessionId ? (sessions[entry.sessionId]?.name || entry.sessionId) : null
  const imagePath = entry.image?.path || entry.imagePath || null
  const imageUrl = imagePath
    ? imagePath.startsWith('data/memory-images/')
      ? `/api/memory-images/${imagePath.split('/').pop()}`
      : imagePath
    : null

  const inputClass = "w-full px-4 py-3 rounded-[12px] border border-white/[0.06] bg-white/[0.02] text-text outline-none transition-all duration-200 placeholder:text-text-3/40 focus:border-accent-bright/20 focus:bg-white/[0.03]"

  return (
    <div className="flex-1 flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="shrink-0 px-6 py-4 border-b border-white/[0.04] flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5">
            <span className="shrink-0 text-[10px] font-700 uppercase tracking-wider text-accent-bright/70 bg-accent-soft px-2 py-0.5 rounded-[6px]">
              {category}
            </span>
            <h2 className="font-display text-[16px] font-700 truncate tracking-[-0.02em]">{title || 'Untitled'}</h2>
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
            <span className="text-[10px] text-text-3/25 font-mono tabular-nums">
              {new Date(entry.createdAt).toLocaleString()}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {dirty && (
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 rounded-[10px] bg-[#6366F1] text-white text-[12px] font-600
                cursor-pointer border-none transition-all hover:brightness-110 active:scale-[0.97]
                disabled:opacity-50 shadow-[0_2px_10px_rgba(99,102,241,0.2)]"
              style={{ fontFamily: 'inherit' }}
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          )}
          <button
            onClick={() => setConfirmDelete(true)}
            className="p-2 rounded-[8px] text-text-3/40 hover:text-red-400 hover:bg-red-400/[0.06]
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

      {/* Edit form */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="max-w-[640px] space-y-5">
          {/* Title */}
          <div>
            <label className="block text-[11px] font-600 text-text-3/60 uppercase tracking-[0.06em] mb-2">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => { setTitle(e.target.value); setDirty(true) }}
              className={`${inputClass} text-[15px] font-600`}
              style={{ fontFamily: 'inherit' }}
              placeholder="Memory title"
            />
          </div>

          {/* Category */}
          <div>
            <label className="block text-[11px] font-600 text-text-3/60 uppercase tracking-[0.06em] mb-2">Category</label>
            <div className="flex gap-1.5 flex-wrap">
              {CATEGORIES.map((c) => (
                <button
                  key={c}
                  onClick={() => { setCategory(c); setDirty(true) }}
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

          {/* Content */}
          <div>
            <label className="block text-[11px] font-600 text-text-3/60 uppercase tracking-[0.06em] mb-2">Content</label>
            <textarea
              value={content}
              onChange={(e) => { setContent(e.target.value); setDirty(true) }}
              placeholder="Memory content..."
              rows={12}
              className={`${inputClass} text-[14px] resize-y min-h-[200px] leading-relaxed`}
              style={{ fontFamily: 'inherit' }}
            />
          </div>

          {imageUrl && (
            <div>
              <label className="block text-[11px] font-600 text-text-3/60 uppercase tracking-[0.06em] mb-2">Image</label>
              <a href={imageUrl} target="_blank" rel="noreferrer" className="inline-block rounded-[12px] overflow-hidden border border-white/[0.08]">
                <img src={imageUrl} alt={entry.title} className="max-w-[320px] max-h-[220px] object-cover block" />
              </a>
            </div>
          )}

          {entry.references?.length ? (
            <div>
              <label className="block text-[11px] font-600 text-text-3/60 uppercase tracking-[0.06em] mb-2">References</label>
              <div className="space-y-2">
                {entry.references.map((ref, idx) => (
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
            </div>
          ) : null}

          {entry.linkedMemoryIds?.length ? (
            <div>
              <label className="block text-[11px] font-600 text-text-3/60 uppercase tracking-[0.06em] mb-2">Linked Memories</label>
              <div className="flex flex-wrap gap-1.5">
                {entry.linkedMemoryIds.map((id) => (
                  <button
                    key={id}
                    onClick={() => setSelectedId(id)}
                    className="px-2.5 py-1 rounded-[8px] text-[11px] font-mono bg-white/[0.04] border border-white/[0.08] text-accent-bright/70 hover:text-accent-bright cursor-pointer transition-colors"
                  >
                    {id}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {/* Metadata */}
          <div className="pt-4 border-t border-white/[0.04]">
            <div className="grid grid-cols-2 gap-4 text-[11px]">
              <div>
                <span className="text-text-3/40 block mb-1">ID</span>
                <span className="text-text-3/60 font-mono">{entry.id}</span>
              </div>
              <div>
                <span className="text-text-3/40 block mb-1">Created</span>
                <span className="text-text-3/60 font-mono">{new Date(entry.createdAt).toLocaleString()}</span>
              </div>
              <div>
                <span className="text-text-3/40 block mb-1">Updated</span>
                <span className="text-text-3/60 font-mono">{new Date(entry.updatedAt).toLocaleString()}</span>
              </div>
              {entry.agentId && (
                <div>
                  <span className="text-text-3/40 block mb-1">Agent</span>
                  <span className="text-text-3/60 font-mono">{agentName}</span>
                </div>
              )}
              {entry.sessionId && (
                <div>
                  <span className="text-text-3/40 block mb-1">Session</span>
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
        </div>
      </div>

      {/* Delete confirmation */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setConfirmDelete(false)} />
          <div className="relative bg-raised rounded-[16px] p-6 max-w-[360px] w-full shadow-xl border border-white/[0.06]"
            style={{ animation: 'fade-in 0.15s cubic-bezier(0.16, 1, 0.3, 1)' }}>
            <h3 className="font-display text-[16px] font-700 mb-2">Delete Memory</h3>
            <p className="text-[13px] text-text-3 mb-5">
              Delete &ldquo;{entry.title}&rdquo;? This cannot be undone.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmDelete(false)}
                className="flex-1 py-2.5 rounded-[10px] border border-white/[0.08] bg-transparent text-text-2 text-[13px] font-600 cursor-pointer hover:bg-surface-2 transition-all"
                style={{ fontFamily: 'inherit' }}
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                className="flex-1 py-2.5 rounded-[10px] border-none bg-red-500/90 text-white text-[13px] font-600 cursor-pointer active:scale-[0.97] transition-all hover:bg-red-500"
                style={{ fontFamily: 'inherit' }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
