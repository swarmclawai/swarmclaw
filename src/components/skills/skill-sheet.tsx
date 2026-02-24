'use client'

import { useEffect, useState, useRef } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import { AiGenBlock } from '@/components/shared/ai-gen-block'
import { api } from '@/lib/api-client'

export function SkillSheet() {
  const open = useAppStore((s) => s.skillSheetOpen)
  const setOpen = useAppStore((s) => s.setSkillSheetOpen)
  const editingId = useAppStore((s) => s.editingSkillId)
  const setEditingId = useAppStore((s) => s.setEditingSkillId)
  const skills = useAppStore((s) => s.skills)
  const loadSkills = useAppStore((s) => s.loadSkills)
  const fileRef = useRef<HTMLInputElement>(null)

  const [name, setName] = useState('')
  const [filename, setFilename] = useState('')
  const [description, setDescription] = useState('')
  const [content, setContent] = useState('')
  const [importUrl, setImportUrl] = useState('')
  const [importingUrl, setImportingUrl] = useState(false)
  const [importError, setImportError] = useState('')
  const [importNotice, setImportNotice] = useState('')

  // AI generation state
  const [aiPrompt, setAiPrompt] = useState('')
  const [generating, setGenerating] = useState(false)
  const [generated, setGenerated] = useState(false)
  const [genError, setGenError] = useState('')
  const appSettings = useAppStore((s) => s.appSettings)
  const loadSettings = useAppStore((s) => s.loadSettings)

  const editing = editingId ? skills[editingId] : null

  const handleGenerate = async () => {
    if (!aiPrompt.trim()) return
    setGenerating(true)
    setGenError('')
    try {
      const result = await api<{ name?: string; description?: string; content?: string; error?: string }>('POST', '/generate', { type: 'skill', prompt: aiPrompt })
      if (result.error) {
        setGenError(result.error)
      } else if (result.name || result.content) {
        if (result.name) { setName(result.name); setFilename(`${result.name.toLowerCase().replace(/\s+/g, '-')}.md`) }
        if (result.description) setDescription(result.description)
        if (result.content) setContent(result.content)
        setGenerated(true)
      } else {
        setGenError('AI returned empty response — try again')
      }
    } catch (err: unknown) {
      setGenError(err instanceof Error ? err.message : 'Generation failed')
    }
    setGenerating(false)
  }

  const handleImportFromUrl = async () => {
    if (!importUrl.trim()) return
    setImportingUrl(true)
    setImportError('')
    setImportNotice('')
    try {
      const result = await api<{ name: string; filename: string; description?: string; content: string; sourceFormat?: 'openclaw' | 'plain' }>('POST', '/skills/import', { url: importUrl.trim() })
      setName(result.name || '')
      setFilename(result.filename || '')
      setDescription(result.description || '')
      setContent(result.content || '')
      if (result.sourceFormat === 'openclaw') {
        setImportNotice('Imported OpenClaw SKILL.md format and stripped frontmatter automatically.')
      } else {
        setImportNotice('Skill imported from URL.')
      }
      setGenerated(false)
    } catch (err: unknown) {
      setImportError(err instanceof Error ? err.message : 'Failed to import skill URL')
    } finally {
      setImportingUrl(false)
    }
  }

  useEffect(() => {
    if (open) {
      loadSettings()
      setAiPrompt('')
      setGenerating(false)
      setGenerated(false)
      setGenError('')
      setImportUrl('')
      setImportingUrl(false)
      setImportError('')
      setImportNotice('')
      if (editing) {
        setName(editing.name)
        setFilename(editing.filename)
        setDescription(editing.description || '')
        setContent(editing.content)
      } else {
        setName('')
        setFilename('')
        setDescription('')
        setContent('')
      }
    }
  }, [open, editingId])

  const onClose = () => {
    setOpen(false)
    setEditingId(null)
  }

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const text = ev.target?.result as string
      setContent(text)
      if (!name) setName(file.name.replace(/\.\w+$/, '').replace(/[-_]/g, ' '))
      if (!filename) setFilename(file.name)
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  const handleSave = async () => {
    const data = {
      name: name.trim() || 'Unnamed Skill',
      filename: filename.trim() || `${name.trim().toLowerCase().replace(/\s+/g, '-')}.md`,
      description,
      content,
    }
    if (editing) {
      await api('PUT', `/skills/${editing.id}`, data)
    } else {
      await api('POST', '/skills', data)
    }
    await loadSkills()
    onClose()
  }

  const handleDelete = async () => {
    if (editing) {
      await api('DELETE', `/skills/${editing.id}`)
      await loadSkills()
      onClose()
    }
  }

  const inputClass = "w-full px-4 py-3.5 rounded-[14px] border border-white/[0.08] bg-surface text-text text-[15px] outline-none transition-all duration-200 placeholder:text-text-3/50 focus-glow"

  return (
    <BottomSheet open={open} onClose={onClose} wide>
      <div className="mb-10">
        <h2 className="font-display text-[28px] font-700 tracking-[-0.03em] mb-2">
          {editing ? 'Edit Skill' : 'New Skill'}
        </h2>
        <p className="text-[14px] text-text-3">Upload or write a reusable instruction set for agents</p>
      </div>

      {/* AI Generation */}
      {!editing && <AiGenBlock
        aiPrompt={aiPrompt} setAiPrompt={setAiPrompt}
        generating={generating} generated={generated} genError={genError}
        onGenerate={handleGenerate} appSettings={appSettings}
        placeholder='Describe the skill, e.g. "A frontend design skill for building polished React components with Tailwind"'
      />}

      {/* File upload */}
      {!editing && (
        <div className="mb-8">
          <label
            onClick={() => fileRef.current?.click()}
            className="flex items-center justify-center gap-2.5 w-full py-4 rounded-[14px] border border-dashed border-white/[0.1] bg-transparent text-text-3 text-[14px] font-600 cursor-pointer hover:border-accent-bright/30 hover:text-accent-bright hover:bg-accent-soft transition-all duration-200"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            Upload .md file
          </label>
          <input ref={fileRef} type="file" accept=".md,.txt,.markdown" onChange={handleFileUpload} className="hidden" />
        </div>
      )}

      {!editing && (
        <div className="mb-8 p-4 rounded-[14px] border border-white/[0.08] bg-surface">
          <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-3">Import from URL</label>
          <div className="flex gap-2">
            <input
              type="url"
              value={importUrl}
              onChange={(e) => setImportUrl(e.target.value)}
              placeholder="https://.../SKILL.md"
              className={`${inputClass} flex-1`}
              style={{ fontFamily: 'inherit' }}
            />
            <button
              onClick={handleImportFromUrl}
              disabled={importingUrl || !importUrl.trim()}
              className="px-4 py-3 rounded-[12px] border-none bg-[#6366F1] text-white text-[13px] font-600 cursor-pointer disabled:opacity-30 transition-all hover:brightness-110"
              style={{ fontFamily: 'inherit' }}
            >
              {importingUrl ? 'Importing...' : 'Import'}
            </button>
          </div>
          {importError && <p className="mt-2 text-[12px] text-red-400/80">{importError}</p>}
          {importNotice && <p className="mt-2 text-[12px] text-emerald-400/80">{importNotice}</p>}
        </div>
      )}

      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Name</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Frontend Design" className={inputClass} style={{ fontFamily: 'inherit' }} />
      </div>

      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">
          Description <span className="normal-case tracking-normal font-normal text-text-3">(optional)</span>
        </label>
        <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Short summary of what this skill does" className={inputClass} style={{ fontFamily: 'inherit' }} />
      </div>

      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Content</label>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="# Skill Instructions&#10;&#10;Write your skill content in markdown..."
          rows={10}
          className={`${inputClass} resize-y min-h-[200px] font-mono text-[13px]`}
          style={{ fontFamily: 'inherit' }}
        />
        <p className="text-[11px] text-text-3/70 mt-2">{content.length} characters</p>
      </div>

      <div className="flex gap-3 pt-2 border-t border-white/[0.04]">
        {editing && (
          <button onClick={handleDelete} className="py-3.5 px-6 rounded-[14px] border border-red-500/20 bg-transparent text-red-400 text-[15px] font-600 cursor-pointer hover:bg-red-500/10 transition-all" style={{ fontFamily: 'inherit' }}>
            Delete
          </button>
        )}
        <button onClick={onClose} className="flex-1 py-3.5 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[15px] font-600 cursor-pointer hover:bg-surface-2 transition-all" style={{ fontFamily: 'inherit' }}>
          Cancel
        </button>
        <button onClick={handleSave} disabled={!name.trim() || !content.trim()} className="flex-1 py-3.5 rounded-[14px] border-none bg-[#6366F1] text-white text-[15px] font-600 cursor-pointer active:scale-[0.97] disabled:opacity-30 transition-all shadow-[0_4px_20px_rgba(99,102,241,0.25)] hover:brightness-110" style={{ fontFamily: 'inherit' }}>
          {editing ? 'Save' : 'Create'}
        </button>
      </div>
    </BottomSheet>
  )
}
