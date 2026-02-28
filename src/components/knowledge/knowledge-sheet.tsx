'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api-client'
import { useAppStore } from '@/stores/use-app-store'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import type { MemoryEntry } from '@/types'

const ACCEPTED_TYPES = '.txt,.md,.csv,.json,.jsonl,.html,.xml,.yaml,.yml,.toml,.py,.js,.ts,.tsx,.jsx,.go,.rs,.java,.c,.cpp,.h,.rb,.php,.sh,.sql,.log,.pdf'

interface UploadResult {
  title: string
  content: string
  filePath: string
  url: string
  filename: string
  size: number
}

export function KnowledgeSheet() {
  const open = useAppStore((s) => s.knowledgeSheetOpen)
  const setOpen = useAppStore((s) => s.setKnowledgeSheetOpen)
  const editingId = useAppStore((s) => s.editingKnowledgeId)

  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [tags, setTags] = useState('')
  const [saving, setSaving] = useState(false)
  const [uploadedFile, setUploadedFile] = useState<{ name: string; url: string; size: number } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const dragCounter = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    if (editingId) {
      void api<MemoryEntry>('GET', `/knowledge/${editingId}`).then((entry) => {
        setTitle(entry.title)
        setContent(entry.content)
        const meta = entry.metadata as { tags?: string[] } | undefined
        setTags(meta?.tags?.join(', ') || '')
      }).catch(() => {
        setOpen(false)
      })
    } else {
      setTitle('')
      setContent('')
      setTags('')
      setUploadedFile(null)
    }
  }, [open, editingId, setOpen])

  const onClose = () => {
    setOpen(false)
    setTitle('')
    setContent('')
    setTags('')
    setUploadedFile(null)
    setIsDragging(false)
    dragCounter.current = 0
  }

  const parseTags = (raw: string): string[] =>
    raw.split(',').map((t) => t.trim()).filter(Boolean)

  const handleUpload = useCallback(async (file: File) => {
    setUploading(true)
    try {
      const res = await fetch('/api/knowledge/upload', {
        method: 'POST',
        headers: { 'X-Filename': file.name },
        body: file,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Upload failed' }))
        console.error('Upload failed:', err.error)
        return
      }
      const result: UploadResult = await res.json()
      if (!title.trim()) setTitle(result.title)
      setContent(result.content)
      setUploadedFile({ name: result.filename, url: result.url, size: result.size })

      // Auto-tag based on file extension
      const ext = file.name.split('.').pop()?.toLowerCase() || ''
      if (ext && !tags.includes(ext)) {
        setTags((prev) => prev ? `${prev}, ${ext}` : ext)
      }
    } catch (err) {
      console.error('Upload error:', err)
    } finally {
      setUploading(false)
    }
  }, [title, tags])

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) void handleUpload(file)
    e.target.value = ''
  }, [handleUpload])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current++
    if (e.dataTransfer.types.includes('Files')) setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current--
    if (dragCounter.current === 0) setIsDragging(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current = 0
    setIsDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (file) void handleUpload(file)
  }, [handleUpload])

  const handleSave = async () => {
    setSaving(true)
    try {
      const payload = {
        title: title.trim() || 'Untitled',
        content,
        tags: parseTags(tags),
      }

      if (editingId) {
        await api('PUT', `/knowledge/${editingId}`, payload)
      } else {
        await api('POST', '/knowledge', payload)
      }

      onClose()
    } catch {
      // silent
    } finally {
      setSaving(false)
    }
  }

  const inputClass = "w-full px-4 py-3.5 rounded-[14px] border border-white/[0.08] bg-surface text-text text-[15px] outline-none transition-all duration-200 placeholder:text-text-3/50 focus-glow"

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  return (
    <BottomSheet open={open} onClose={onClose}>
      <div className="mb-10">
        <h2 className="font-display text-[28px] font-700 tracking-[-0.03em] mb-2">
          {editingId ? 'Edit Knowledge' : 'New Knowledge'}
        </h2>
        <p className="text-[14px] text-text-3">
          {editingId ? 'Update this knowledge entry' : 'Add shared knowledge for agents — type or upload a document'}
        </p>
      </div>

      {/* Document upload zone — only show when creating new */}
      {!editingId && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">
            Upload Document
          </label>

          {uploadedFile ? (
            <div className="flex items-center gap-3 px-4 py-3 rounded-[14px] border border-emerald-500/20 bg-emerald-500/[0.04]">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-emerald-400 shrink-0">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <polyline points="9 15 12 12 15 15" />
              </svg>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] text-text font-500 truncate">{uploadedFile.name}</p>
                <p className="text-[11px] text-text-3/60">{formatSize(uploadedFile.size)} — content extracted</p>
              </div>
              <button
                onClick={() => {
                  setUploadedFile(null)
                  setContent('')
                  setTitle('')
                }}
                className="p-1.5 rounded-[8px] text-text-3 hover:text-red-400 hover:bg-red-400/10 border-none bg-transparent cursor-pointer transition-colors"
                aria-label="Remove uploaded file"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          ) : (
            <div
              onDragOver={handleDragOver}
              onDragEnter={handleDragEnter}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`flex flex-col items-center gap-3 px-6 py-8 rounded-[14px] border-2 border-dashed cursor-pointer transition-all duration-200
                ${isDragging
                  ? 'border-accent-bright/50 bg-accent-soft/20'
                  : 'border-white/[0.08] bg-white/[0.02] hover:border-white/[0.15] hover:bg-white/[0.03]'
                }
                ${uploading ? 'opacity-60 pointer-events-none' : ''}`}
            >
              {uploading ? (
                <>
                  <div className="w-8 h-8 border-2 border-accent-bright/30 border-t-accent-bright rounded-full" style={{ animation: 'spin 0.8s linear infinite' }} />
                  <p className="text-[13px] text-text-3">Extracting content...</p>
                </>
              ) : (
                <>
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-text-3/50">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  <div className="text-center">
                    <p className="text-[14px] text-text-2 font-500">
                      {isDragging ? 'Drop document here' : 'Drop a document or click to browse'}
                    </p>
                    <p className="text-[11px] text-text-3/50 mt-1">
                      Supports .txt, .md, .csv, .json, .pdf, code files, and more
                    </p>
                  </div>
                </>
              )}
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_TYPES}
            onChange={handleFileChange}
            className="hidden"
          />
        </div>
      )}

      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Title</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Knowledge title"
          className={inputClass}
          style={{ fontFamily: 'inherit' }}
        />
      </div>

      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">
          Content
          {content.length > 0 && (
            <span className="ml-2 text-text-3/40 font-mono text-[10px] normal-case tracking-normal">
              {content.length.toLocaleString()} chars
            </span>
          )}
        </label>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Knowledge content..."
          rows={6}
          className={`${inputClass} resize-y min-h-[150px]`}
          style={{ fontFamily: 'inherit' }}
        />
      </div>

      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Tags</label>
        <input
          type="text"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="api, docs, internal (comma-separated)"
          className={inputClass}
          style={{ fontFamily: 'inherit' }}
        />
      </div>

      <div className="flex gap-3 pt-2 border-t border-white/[0.04]">
        <button
          onClick={onClose}
          className="flex-1 py-3.5 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[15px] font-600 cursor-pointer hover:bg-surface-2 transition-all"
          style={{ fontFamily: 'inherit' }}
        >
          Cancel
        </button>
        <button
          onClick={() => { void handleSave() }}
          disabled={!title.trim() || saving}
          className="flex-1 py-3.5 rounded-[14px] border-none bg-[#6366F1] text-white text-[15px] font-600 cursor-pointer active:scale-[0.97] disabled:opacity-30 transition-all shadow-[0_4px_20px_rgba(99,102,241,0.25)] hover:brightness-110"
          style={{ fontFamily: 'inherit' }}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </BottomSheet>
  )
}
