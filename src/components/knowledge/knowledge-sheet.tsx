'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/app/api-client'
import { useAppStore } from '@/stores/use-app-store'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import type { KnowledgeSourceDetail, KnowledgeSourceKind } from '@/types'
import { toast } from 'sonner'

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
  const open = useAppStore((state) => state.knowledgeSheetOpen)
  const setOpen = useAppStore((state) => state.setKnowledgeSheetOpen)
  const editingId = useAppStore((state) => state.editingKnowledgeId)
  const setEditingKnowledgeId = useAppStore((state) => state.setEditingKnowledgeId)
  const setSelectedKnowledgeSourceId = useAppStore((state) => state.setSelectedKnowledgeSourceId)
  const triggerKnowledgeRefresh = useAppStore((state) => state.triggerKnowledgeRefresh)
  const agents = useAppStore((state) => state.agents)
  const loadAgents = useAppStore((state) => state.loadAgents)

  const [kind, setKind] = useState<KnowledgeSourceKind>('manual')
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [tags, setTags] = useState('')
  const [scope, setScope] = useState<'global' | 'agent'>('global')
  const [agentIds, setAgentIds] = useState<string[]>([])
  const [sourceUrl, setSourceUrl] = useState('')
  const [sourcePath, setSourcePath] = useState('')
  const [sourceLabel, setSourceLabel] = useState('')
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [uploadedFile, setUploadedFile] = useState<{ name: string; url: string; size: number | null } | null>(null)

  const dragCounter = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const agentList = Object.values(agents)

  useEffect(() => {
    if (open) loadAgents()
  }, [loadAgents, open])

  const resetForm = useCallback(() => {
    setKind('manual')
    setTitle('')
    setContent('')
    setTags('')
    setScope('global')
    setAgentIds([])
    setSourceUrl('')
    setSourcePath('')
    setSourceLabel('')
    setUploadedFile(null)
    setIsDragging(false)
    dragCounter.current = 0
  }, [])

  useEffect(() => {
    if (!open) return
    if (!editingId) {
      resetForm()
      return
    }

    resetForm()
    void api<KnowledgeSourceDetail>('GET', `/knowledge/sources/${editingId}`).then((detail) => {
      const { source } = detail
      setKind(source.kind)
      setTitle(source.title)
      setContent(source.content || '')
      setTags(source.tags.join(', '))
      setScope(source.scope)
      setAgentIds(source.agentIds)
      setSourceUrl(source.sourceUrl || '')
      setSourcePath(source.sourcePath || '')
      setSourceLabel(source.sourceLabel || '')
      setUploadedFile(source.kind === 'file'
        ? { name: source.sourceLabel || source.title, url: source.sourceUrl || '', size: null }
        : null)
    }).catch(() => {
      toast.error('Unable to load this knowledge source')
      setOpen(false)
    })
  }, [editingId, open, resetForm, setOpen])

  const onClose = useCallback(() => {
    setOpen(false)
    setEditingKnowledgeId(null)
    resetForm()
  }, [resetForm, setEditingKnowledgeId, setOpen])

  const parseTags = (raw: string): string[] =>
    raw.split(',').map((tag) => tag.trim()).filter(Boolean)

  const toggleAgent = (id: string) => {
    setAgentIds((current) => current.includes(id) ? current.filter((agentId) => agentId !== id) : [...current, id])
  }

  const handleUpload = useCallback(async (file: File) => {
    setUploading(true)
    try {
      const response = await fetch('/api/knowledge/upload', {
        method: 'POST',
        headers: { 'X-Filename': file.name },
        body: file,
      })

      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: 'Upload failed' }))
        toast.error(payload.error || 'Upload failed')
        return
      }

      const result: UploadResult = await response.json()
      setKind('file')
      setTitle((current) => current.trim() || result.title)
      setContent(result.content)
      setSourcePath(result.filePath)
      setSourceUrl(result.url)
      setSourceLabel(result.filename)
      setUploadedFile({ name: result.filename, url: result.url, size: result.size })
      toast.success('Document content extracted')

      const ext = file.name.split('.').pop()?.toLowerCase() || ''
      if (ext) {
        setTags((current) => current.includes(ext) ? current : current ? `${current}, ${ext}` : ext)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }, [])

  const handleFileChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) void handleUpload(file)
    event.target.value = ''
  }, [handleUpload])

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
  }, [])

  const handleDragEnter = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    dragCounter.current += 1
    if (event.dataTransfer.types.includes('Files')) setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    dragCounter.current -= 1
    if (dragCounter.current === 0) setIsDragging(false)
  }, [])

  const handleDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    dragCounter.current = 0
    setIsDragging(false)
    const file = event.dataTransfer.files?.[0]
    if (file) void handleUpload(file)
  }, [handleUpload])

  const handleSave = async () => {
    if (kind === 'manual' && !content.trim()) {
      toast.error('Manual knowledge needs content')
      return
    }
    if (kind === 'file' && !sourcePath && !content.trim()) {
      toast.error('Upload a file or provide extracted content')
      return
    }
    if (kind === 'url' && !sourceUrl.trim()) {
      toast.error('A URL is required for URL knowledge')
      return
    }

    setSaving(true)
    try {
      const payload = {
        kind,
        title: title.trim(),
        content,
        tags: parseTags(tags),
        scope,
        agentIds: scope === 'agent' ? agentIds : [],
        sourceUrl: sourceUrl.trim() || undefined,
        sourcePath: sourcePath.trim() || undefined,
        sourceLabel: sourceLabel.trim() || undefined,
        metadata: uploadedFile?.size != null
          ? { fileSize: uploadedFile.size }
          : undefined,
      }

      const detail = editingId
        ? await api<KnowledgeSourceDetail>('PUT', `/knowledge/sources/${editingId}`, payload)
        : await api<KnowledgeSourceDetail>('POST', '/knowledge/sources', payload)

      setSelectedKnowledgeSourceId(detail.source.id)
      triggerKnowledgeRefresh()
      toast.success(editingId ? 'Knowledge source updated' : 'Knowledge source created')
      onClose()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save knowledge')
    } finally {
      setSaving(false)
    }
  }

  const formatSize = (bytes: number | null) => {
    if (bytes == null) return null
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const inputClass = 'w-full px-4 py-3.5 rounded-[14px] border border-white/[0.08] bg-surface text-text text-[15px] outline-none transition-all duration-200 placeholder:text-text-3/50 focus-glow'
  const scopeHelperText = scope === 'global'
    ? 'This source will be searchable across the whole fleet'
    : agentIds.length === 0
      ? 'Select which agents should receive this source during retrieval'
      : `${agentIds.length} agent(s) selected`

  const canSave = kind === 'manual'
    ? Boolean(content.trim())
    : kind === 'file'
      ? Boolean(sourcePath || content.trim())
      : Boolean(sourceUrl.trim())

  return (
    <BottomSheet open={open} onClose={onClose}>
      <div className="mb-10">
        <h2 className="font-display text-[28px] font-700 tracking-[-0.03em] mb-2">
          {editingId ? 'Edit Knowledge Source' : 'New Knowledge Source'}
        </h2>
        <p className="text-[14px] text-text-3">
          Manual notes, uploaded files, and imported URLs all index into the same knowledge library.
        </p>
      </div>

      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Source Type</label>
        <div className="grid grid-cols-3 gap-2">
          {(['manual', 'file', 'url'] as const).map((sourceKind) => (
            <button
              key={sourceKind}
              onClick={() => setKind(sourceKind)}
              className={`py-3 rounded-[14px] text-[13px] font-600 border transition-all cursor-pointer ${
                kind === sourceKind
                  ? 'border-accent-bright/25 bg-accent-soft text-accent-bright'
                  : 'border-white/[0.08] bg-white/[0.02] text-text-3 hover:text-text-2'
              }`}
              style={{ fontFamily: 'inherit' }}
            >
              {sourceKind === 'manual' ? 'Manual' : sourceKind === 'file' ? 'File' : 'URL'}
            </button>
          ))}
        </div>
      </div>

      {kind === 'file' && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Upload Document</label>

          {uploadedFile ? (
            <div className="flex items-center gap-3 px-4 py-3 rounded-[14px] border border-emerald-500/20 bg-emerald-500/[0.04]">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-emerald-400 shrink-0">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <polyline points="9 15 12 12 15 15" />
              </svg>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] text-text font-500 truncate">{uploadedFile.name}</p>
                <p className="text-[11px] text-text-3/60">
                  {formatSize(uploadedFile.size) ? `${formatSize(uploadedFile.size)} • ` : ''}content extracted
                </p>
              </div>
              <button
                onClick={() => {
                  setUploadedFile(null)
                  setSourcePath('')
                  setSourceUrl('')
                  setSourceLabel('')
                  setContent('')
                }}
                className="p-1.5 rounded-[8px] text-text-3 hover:text-red-400 hover:bg-red-400/10 border-none bg-transparent cursor-pointer transition-colors"
                aria-label="Remove uploaded file"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
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
              className={`flex flex-col items-center gap-3 px-6 py-8 rounded-[14px] border-2 border-dashed cursor-pointer transition-all duration-200 ${
                isDragging
                  ? 'border-accent-bright/50 bg-accent-soft/20'
                  : 'border-white/[0.08] bg-white/[0.02] hover:border-white/[0.15] hover:bg-white/[0.03]'
              } ${uploading ? 'opacity-60 pointer-events-none' : ''}`}
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
                      Supports text, code, structured files, and PDFs
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

      {kind === 'url' && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Source URL</label>
          <input
            type="url"
            value={sourceUrl}
            onChange={(event) => setSourceUrl(event.target.value)}
            placeholder="https://example.com/docs/article"
            className={inputClass}
            style={{ fontFamily: 'inherit' }}
          />
          <p className="text-[11px] text-text-3/55 mt-1.5 pl-1">
            Save to fetch, clean, and index the page. You can also edit the extracted text below before saving again.
          </p>
        </div>
      )}

      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Title</label>
        <input
          type="text"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Knowledge title"
          className={inputClass}
          style={{ fontFamily: 'inherit' }}
        />
      </div>

      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">
          Indexed Content
          {content.length > 0 && (
            <span className="ml-2 text-text-3/40 font-mono text-[10px] normal-case tracking-normal">
              {content.length.toLocaleString()} chars
            </span>
          )}
        </label>
        <textarea
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder={kind === 'manual' ? 'Knowledge content...' : 'Extracted content appears here after import'}
          rows={8}
          className={`${inputClass} resize-y min-h-[180px]`}
          style={{ fontFamily: 'inherit' }}
        />
      </div>

      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Tags</label>
        <input
          type="text"
          value={tags}
          onChange={(event) => setTags(event.target.value)}
          placeholder="api, docs, internal (comma-separated)"
          className={inputClass}
          style={{ fontFamily: 'inherit' }}
        />
      </div>

      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Scope</label>
        <div className="flex p-1 rounded-[12px] bg-bg border border-white/[0.06]">
          {(['global', 'agent'] as const).map((nextScope) => (
            <button
              key={nextScope}
              onClick={() => setScope(nextScope)}
              className={`flex-1 py-2.5 rounded-[10px] text-center cursor-pointer transition-all text-[13px] font-600 border-none ${
                scope === nextScope ? 'bg-accent-soft text-accent-bright' : 'bg-transparent text-text-3 hover:text-text-2'
              }`}
              style={{ fontFamily: 'inherit' }}
            >
              {nextScope === 'global' ? 'Global' : 'Specific'}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-text-3/60 mt-1.5 pl-1">{scopeHelperText}</p>
      </div>

      {scope === 'agent' && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Agents</label>
          <div className="max-h-[240px] overflow-y-auto rounded-[12px] border border-white/[0.06] bg-white/[0.03]">
            {agentList.length === 0 ? (
              <p className="p-3 text-[12px] text-text-3">No agents available</p>
            ) : (
              agentList.map((agent) => {
                const selected = agentIds.includes(agent.id)
                return (
                  <button
                    key={agent.id}
                    onClick={() => toggleAgent(agent.id)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-all cursor-pointer ${
                      selected ? 'bg-accent-soft/40' : 'hover:bg-white/[0.04]'
                    }`}
                    style={{ fontFamily: 'inherit' }}
                  >
                    <AgentAvatar seed={agent.avatarSeed} avatarUrl={agent.avatarUrl} name={agent.name} size={24} />
                    <span className="text-[13px] text-text flex-1 truncate">{agent.name}</span>
                    {selected && (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-accent-bright shrink-0">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </button>
                )
              })
            )}
          </div>
        </div>
      )}

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
          disabled={!canSave || saving}
          className="flex-1 py-3.5 rounded-[14px] border-none bg-accent-bright text-white text-[15px] font-600 cursor-pointer active:scale-[0.97] disabled:opacity-30 transition-all shadow-[0_4px_20px_rgba(99,102,241,0.25)] hover:brightness-110"
          style={{ fontFamily: 'inherit' }}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </BottomSheet>
  )
}
