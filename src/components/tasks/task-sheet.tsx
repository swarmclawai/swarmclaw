'use client'

import { useEffect, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { createTask, updateTask, deleteTask } from '@/lib/tasks'
import { api } from '@/lib/api-client'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import type { BoardTask, TaskComment } from '@/types'

function fmtTime(ts: number) {
  const d = new Date(ts)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  if (isToday) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function TaskSheet() {
  const open = useAppStore((s) => s.taskSheetOpen)
  const setOpen = useAppStore((s) => s.setTaskSheetOpen)
  const editingId = useAppStore((s) => s.editingTaskId)
  const setEditingId = useAppStore((s) => s.setEditingTaskId)
  const tasks = useAppStore((s) => s.tasks)
  const loadTasks = useAppStore((s) => s.loadTasks)
  const agents = useAppStore((s) => s.agents)
  const loadAgents = useAppStore((s) => s.loadAgents)

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [agentId, setAgentId] = useState('')
  const [commentText, setCommentText] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [uploading, setUploading] = useState(false)
  const [cwd, setCwd] = useState('')
  const [dirSearch, setDirSearch] = useState('')

  const dirs = useAppStore((s) => s.dirs)
  const loadDirs = useAppStore((s) => s.loadDirs)

  const editing = editingId ? tasks[editingId] : null
  const orchestrators = Object.values(agents).filter((p) => p.isOrchestrator)

  useEffect(() => {
    if (open) {
      loadAgents()
      loadDirs()
      if (editing) {
        setTitle(editing.title)
        setDescription(editing.description)
        setAgentId(editing.agentId)
        setImages(editing.images || [])
        setCwd(editing.cwd || '')
      } else {
        setTitle('')
        setDescription('')
        setAgentId(orchestrators[0]?.id || '')
        setImages([])
        setCwd('')
        setDirSearch('')
      }
    }
  }, [open, editingId])

  // Update default agent when orchestrators load
  useEffect(() => {
    if (open && !editing && !agentId && orchestrators.length) {
      setAgentId(orchestrators[0].id)
    }
  }, [agents])

  const onClose = () => {
    setOpen(false)
    setEditingId(null)
  }

  const handleSave = async () => {
    const payload = { title: title.trim() || 'Untitled Task', description, agentId, images, cwd: cwd || undefined } as any
    if (editing) {
      await updateTask(editing.id, payload)
    } else {
      await createTask(payload)
    }
    await loadTasks()
    onClose()
  }

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'x-filename': file.name },
        body: await file.arrayBuffer(),
      })
      const data = await res.json()
      if (data.url) setImages((prev) => [...prev, data.url])
    } catch { /* ignore */ }
    setUploading(false)
    e.target.value = ''
  }

  const handleDelete = async () => {
    if (editing) {
      await deleteTask(editing.id)
      await loadTasks()
      onClose()
    }
  }

  const handleQueue = async () => {
    if (editing && editing.status === 'backlog') {
      await updateTask(editing.id, { status: 'queued' })
      await loadTasks()
      onClose()
    }
  }

  const handleAddComment = async () => {
    if (!editing || !commentText.trim()) return
    const c: TaskComment = {
      id: crypto.randomUUID().slice(0, 8),
      author: 'You',
      text: commentText.trim(),
      createdAt: Date.now(),
    }
    // Use atomic append to avoid race conditions with queue-added comments
    await updateTask(editing.id, { appendComment: c } as any)
    await loadTasks()
    setCommentText('')
  }

  const inputClass = "w-full px-4 py-3.5 rounded-[14px] border border-white/[0.08] bg-surface text-text text-[15px] outline-none transition-all duration-200 placeholder:text-text-3/50 focus-glow"

  return (
    <BottomSheet open={open} onClose={onClose}>
      <div className="mb-10">
        <h2 className="font-display text-[28px] font-700 tracking-[-0.03em] mb-2">
          {editing ? 'Edit Task' : 'New Task'}
        </h2>
        <p className="text-[14px] text-text-3">
          {editing ? `Status: ${editing.status}` : 'Create a task and assign an orchestrator'}
        </p>
      </div>

      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Title</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Run full site audit"
          className={inputClass}
          style={{ fontFamily: 'inherit' }}
        />
      </div>

      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Description</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Detailed task instructions for the orchestrator..."
          rows={4}
          className={`${inputClass} resize-y min-h-[100px]`}
          style={{ fontFamily: 'inherit' }}
        />
      </div>

      {/* Images */}
      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">
          Images <span className="normal-case tracking-normal font-normal text-text-3">(optional — reference designs, mockups, etc.)</span>
        </label>
        {images.length > 0 && (
          <div className="flex gap-2 flex-wrap mb-3">
            {images.map((url, i) => (
              <div key={i} className="relative group">
                <img src={url} alt="" className="w-20 h-20 rounded-[10px] object-cover border border-white/[0.08]" />
                <button
                  onClick={() => setImages((prev) => prev.filter((_, idx) => idx !== i))}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-500 text-white flex items-center justify-center text-[11px] font-700 cursor-pointer
                    opacity-0 group-hover:opacity-100 transition-opacity border-none"
                >
                  x
                </button>
              </div>
            ))}
          </div>
        )}
        <label className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-[12px] border border-white/[0.06] bg-surface text-text-3 text-[13px] font-600 cursor-pointer hover:bg-surface-2 transition-colors ${uploading ? 'opacity-50 pointer-events-none' : ''}`}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
          {uploading ? 'Uploading...' : 'Add Image'}
          <input type="file" accept="image/*" onChange={handleImageUpload} className="hidden" />
        </label>
      </div>

      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Orchestrator</label>
        {orchestrators.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {orchestrators.map((p) => (
              <button
                key={p.id}
                onClick={() => setAgentId(p.id)}
                className={`px-4 py-3 rounded-[12px] text-[14px] font-600 cursor-pointer transition-all border
                  ${agentId === p.id
                    ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
                    : 'bg-surface border-white/[0.06] text-text-2 hover:bg-surface-2'}`}
                style={{ fontFamily: 'inherit' }}
              >
                {p.name}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-[13px] text-text-3">No orchestrator agents configured. Create one in Agents first.</p>
        )}
      </div>

      {/* Directory (optional) */}
      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">
          Directory <span className="normal-case tracking-normal font-normal text-text-3">(optional — project to work in)</span>
        </label>
        {cwd ? (
          <div className="flex items-center gap-2">
            <span className="flex-1 px-4 py-3 rounded-[14px] border border-accent-bright/20 bg-accent-soft text-accent-bright text-[14px] font-mono truncate">
              {cwd.replace(/^\/Users\/\w+/, '~')}
            </span>
            <button onClick={() => setCwd('')} className="px-3 py-3 rounded-[14px] border border-white/[0.08] bg-surface text-text-3 text-[13px] cursor-pointer hover:bg-surface-2 transition-colors" style={{ fontFamily: 'inherit' }}>
              Clear
            </button>
          </div>
        ) : (
          <>
            <input
              type="text"
              value={dirSearch}
              onChange={(e) => setDirSearch(e.target.value)}
              placeholder="Search directories..."
              className={`${inputClass} mb-3`}
              style={{ fontFamily: 'inherit' }}
            />
            <div className="grid grid-cols-3 gap-2 max-h-[120px] overflow-y-auto">
              {(dirSearch ? dirs.filter((d) => d.name.toLowerCase().includes(dirSearch.toLowerCase())) : dirs).slice(0, 12).map((d) => (
                <button
                  key={d.path}
                  onClick={() => { setCwd(d.path); if (!title) setTitle(d.name) }}
                  className="py-2.5 px-3 rounded-[10px] text-center cursor-pointer transition-all border bg-surface border-white/[0.06] text-text-2 hover:bg-surface-2 text-[12px] font-600 truncate"
                  style={{ fontFamily: 'inherit' }}
                >
                  {d.name}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {editing?.result && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Result</label>
          <div className="p-4 rounded-[14px] border border-white/[0.06] bg-surface text-[13px] text-text-2 whitespace-pre-wrap max-h-[200px] overflow-y-auto">
            {editing.result}
          </div>
        </div>
      )}

      {editing?.error && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-red-400 uppercase tracking-[0.08em] mb-3">Error</label>
          <div className="p-4 rounded-[14px] border border-red-500/10 bg-red-500/[0.03] text-[13px] text-red-400/80 whitespace-pre-wrap">
            {editing.error}
          </div>
        </div>
      )}

      {/* Comments */}
      {editing && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">
            Comments {editing.comments?.length ? `(${editing.comments.length})` : ''}
          </label>

          {editing.comments && editing.comments.length > 0 && (
            <div className="space-y-3 mb-4 max-h-[300px] overflow-y-auto">
              {editing.comments.map((c) => (
                <div key={c.id} className="p-3.5 rounded-[12px] border border-white/[0.06] bg-surface">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className={`text-[12px] font-600 ${c.agentId ? 'text-accent-bright' : 'text-text-2'}`}>
                      {c.author}
                    </span>
                    <span className="text-[10px] text-text-3/50 font-mono">{fmtTime(c.createdAt)}</span>
                  </div>
                  <p className="text-[13px] text-text-2 leading-[1.5] whitespace-pre-wrap">{c.text}</p>
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <input
              type="text"
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              placeholder="Add a comment..."
              className={`${inputClass} flex-1`}
              style={{ fontFamily: 'inherit' }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAddComment() } }}
            />
            <button
              onClick={handleAddComment}
              disabled={!commentText.trim()}
              className="px-4 py-3 rounded-[14px] border-none bg-accent-soft text-accent-bright text-[13px] font-600 cursor-pointer disabled:opacity-30 hover:brightness-110 transition-all shrink-0"
              style={{ fontFamily: 'inherit' }}
            >
              Post
            </button>
          </div>
        </div>
      )}

      <div className="flex gap-3 pt-2 border-t border-white/[0.04]">
        {editing && (
          <button onClick={handleDelete} className="py-3.5 px-6 rounded-[14px] border border-red-500/20 bg-transparent text-red-400 text-[15px] font-600 cursor-pointer hover:bg-red-500/10 transition-all" style={{ fontFamily: 'inherit' }}>
            Delete
          </button>
        )}
        {editing && editing.status === 'backlog' && (
          <button onClick={handleQueue} className="py-3.5 px-6 rounded-[14px] border border-amber-500/20 bg-transparent text-amber-400 text-[15px] font-600 cursor-pointer hover:bg-amber-500/10 transition-all" style={{ fontFamily: 'inherit' }}>
            Queue
          </button>
        )}
        <button onClick={onClose} className="flex-1 py-3.5 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[15px] font-600 cursor-pointer hover:bg-surface-2 transition-all" style={{ fontFamily: 'inherit' }}>
          Cancel
        </button>
        <button onClick={handleSave} disabled={!title.trim() || !agentId} className="flex-1 py-3.5 rounded-[14px] border-none bg-[#6366F1] text-white text-[15px] font-600 cursor-pointer active:scale-[0.97] disabled:opacity-30 transition-all shadow-[0_4px_20px_rgba(99,102,241,0.25)] hover:brightness-110" style={{ fontFamily: 'inherit' }}>
          {editing ? 'Save' : 'Create'}
        </button>
      </div>
    </BottomSheet>
  )
}
