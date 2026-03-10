'use client'

import { useEffect, useState, useRef, type ChangeEvent } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import { ConfirmDialog } from '@/components/shared/confirm-dialog'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { api } from '@/lib/app/api-client'
import { buildSkillSavePayload } from '@/lib/skill-save-payload'
import { toast } from 'sonner'
import type { Skill, SkillSecuritySummary } from '@/types'

export function SkillSheet() {
  const open = useAppStore((s) => s.skillSheetOpen)
  const setOpen = useAppStore((s) => s.setSkillSheetOpen)
  const editingId = useAppStore((s) => s.editingSkillId)
  const setEditingId = useAppStore((s) => s.setEditingSkillId)
  const skills = useAppStore((s) => s.skills)
  const loadSkills = useAppStore((s) => s.loadSkills)
  const agents = useAppStore((s) => s.agents)
  const loadAgents = useAppStore((s) => s.loadAgents)
  const fileRef = useRef<HTMLInputElement>(null)

  const [name, setName] = useState('')
  const [filename, setFilename] = useState('')
  const [description, setDescription] = useState('')
  const [content, setContent] = useState('')
  const [scope, setScope] = useState<'global' | 'agent'>('global')
  const [agentIds, setAgentIds] = useState<string[]>([])
  const [importUrl, setImportUrl] = useState('')
  const [importingUrl, setImportingUrl] = useState(false)
  const [importError, setImportError] = useState('')
  const [importNotice, setImportNotice] = useState('')
  const [metadataPreview, setMetadataPreview] = useState<Partial<Skill> | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const editing = editingId ? skills[editingId] : null
  const agentList = Object.values(agents)

  const handleImportFromUrl = async () => {
    if (!importUrl.trim()) return
    setImportingUrl(true)
    setImportError('')
    setImportNotice('')
    try {
      const result = await api<Partial<Skill> & { name: string; filename: string; description?: string; content: string; sourceFormat?: 'openclaw' | 'plain' }>('POST', '/skills/import', { url: importUrl.trim() })
      setName(result.name || '')
      setFilename(result.filename || '')
      setDescription(result.description || '')
      setContent(result.content || '')
      setMetadataPreview(result)
      if (result.sourceFormat === 'openclaw') {
        setImportNotice(`Imported OpenClaw SKILL.md format.${result.security ? ` Security review: ${result.security.level}.` : ''}`)
      } else {
        setImportNotice('Skill imported from URL.')
      }
    } catch (err: unknown) {
      setImportError(err instanceof Error ? err.message : 'Failed to import skill URL')
    } finally {
      setImportingUrl(false)
    }
  }

  useEffect(() => {
    if (open) loadAgents()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (open) {
      setImportUrl('')
      setImportingUrl(false)
      setImportError('')
      setImportNotice('')
      if (editing) {
        setName(editing.name)
        setFilename(editing.filename)
        setDescription(editing.description || '')
        setContent(editing.content)
        setScope(editing.scope || 'global')
        setAgentIds(editing.agentIds || [])
        setMetadataPreview(editing)
      } else {
        setName('')
        setFilename('')
        setDescription('')
        setContent('')
        setScope('global')
        setAgentIds([])
        setMetadataPreview(null)
      }
    }
  }, [open, editingId])

  const onClose = () => {
    setConfirmDelete(false)
    setDeleting(false)
    setOpen(false)
    setEditingId(null)
  }

  const handleFileUpload = (e: ChangeEvent<HTMLInputElement>) => {
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

  const toggleAgent = (id: string) => {
    setAgentIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])
  }

  const scopeHelperText = scope === 'global'
    ? 'This skill will be accessible to all agents'
    : agentIds.length === 0
      ? 'Select which agents can access this skill'
      : `${agentIds.length} agent(s) selected`

  const handleSave = async () => {
    const data = buildSkillSavePayload({
      name,
      filename,
      description,
      content,
      scope,
      agentIds,
    }, metadataPreview)
    try {
      if (editing) {
        await api('PUT', `/skills/${editing.id}`, data)
        toast.success('Skill updated successfully')
      } else {
        await api('POST', '/skills', data)
        toast.success('Skill created successfully')
      }
      await loadSkills()
      onClose()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to save skill')
    }
  }

  const handleDelete = async () => {
    if (!editing) return
    setDeleting(true)
    try {
      await api('DELETE', `/skills/${editing.id}`)
      toast.success('Skill deleted')
      await loadSkills()
      setConfirmDelete(false)
      onClose()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete skill')
    } finally {
      setDeleting(false)
    }
  }

  const inputClass = "w-full px-4 py-3.5 rounded-[14px] border border-white/[0.08] bg-surface text-text text-[15px] outline-none transition-all duration-200 placeholder:text-text-3/50 focus-glow"
  const previewSecurity = metadataPreview?.security as SkillSecuritySummary | undefined
  const requirementCount = (metadataPreview?.skillRequirements?.env?.length || 0)
    + (metadataPreview?.skillRequirements?.bins?.length || 0)
    + (metadataPreview?.skillRequirements?.config?.length || 0)

  return (
    <BottomSheet open={open} onClose={onClose} wide>
      <div className="mb-10">
        <h2 className="font-display text-[28px] font-700 tracking-[-0.03em] mb-2">
          {editing ? 'Edit Skill' : 'New Skill'}
        </h2>
        <p className="text-[14px] text-text-3">Upload or write a reusable instruction set for agents</p>
      </div>

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
              className="px-4 py-3 rounded-[12px] border-none bg-accent-bright text-white text-[13px] font-600 cursor-pointer disabled:opacity-30 transition-all hover:brightness-110"
              style={{ fontFamily: 'inherit' }}
            >
              {importingUrl ? 'Importing...' : 'Import'}
            </button>
          </div>
          {importError && <p className="mt-2 text-[12px] text-red-400/80">{importError}</p>}
          {importNotice && <p className="mt-2 text-[12px] text-emerald-400/80">{importNotice}</p>}
        </div>
      )}

      {metadataPreview && (
        <div className="mb-8 rounded-[14px] border border-white/[0.08] bg-white/[0.03] p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[11px] font-700 uppercase tracking-[0.08em] text-text-3/60">Skill Metadata</div>
              <p className="mt-1 text-[13px] text-text-2">
                {metadataPreview.version ? `v${metadataPreview.version}` : 'Unversioned'}
                {metadataPreview.sourceFormat ? ` · ${metadataPreview.sourceFormat}` : ''}
                {requirementCount > 0 ? ` · ${requirementCount} declared requirement${requirementCount === 1 ? '' : 's'}` : ''}
              </p>
            </div>
            {previewSecurity && (
              <span className={`rounded-full px-2.5 py-1 text-[10px] font-700 uppercase tracking-[0.08em] ${
                previewSecurity.level === 'high'
                  ? 'bg-red-500/10 text-red-300 border border-red-500/20'
                  : previewSecurity.level === 'medium'
                    ? 'bg-amber-500/10 text-amber-300 border border-amber-500/20'
                    : 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20'
              }`}>
                {previewSecurity.level} risk
              </span>
            )}
          </div>

          {(metadataPreview.primaryEnv || metadataPreview.homepage || metadataPreview.skillKey) && (
            <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-text-3/70">
              {metadataPreview.primaryEnv && <span className="rounded-full border border-white/[0.08] px-2 py-1">Primary env: {metadataPreview.primaryEnv}</span>}
              {metadataPreview.skillKey && <span className="rounded-full border border-white/[0.08] px-2 py-1">Skill key: {metadataPreview.skillKey}</span>}
              {metadataPreview.homepage && <span className="rounded-full border border-white/[0.08] px-2 py-1">Homepage linked</span>}
            </div>
          )}

          {previewSecurity?.notes?.length ? (
            <div className="mt-3 space-y-1">
              {previewSecurity.notes.slice(0, 4).map((note) => (
                <p key={note} className="text-[12px] text-text-3/75">- {note}</p>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-[12px] text-text-3/65">No obvious requirement or security signals were detected.</p>
          )}
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

      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Scope</label>
        <div className="flex p-1 rounded-[12px] bg-bg border border-white/[0.06]">
          {(['global', 'agent'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setScope(s)}
              className={`flex-1 py-2.5 rounded-[10px] text-center cursor-pointer transition-all text-[13px] font-600 border-none ${
                scope === s ? 'bg-accent-soft text-accent-bright' : 'bg-transparent text-text-3 hover:text-text-2'
              }`}
              style={{ fontFamily: 'inherit' }}
            >
              {s === 'global' ? 'Global' : 'Specific'}
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
        {editing && (
          <button onClick={() => setConfirmDelete(true)} className="py-3.5 px-6 rounded-[14px] border border-red-500/20 bg-transparent text-red-400 text-[15px] font-600 cursor-pointer hover:bg-red-500/10 transition-all" style={{ fontFamily: 'inherit' }}>
            Delete
          </button>
        )}
        <button onClick={onClose} className="flex-1 py-3.5 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[15px] font-600 cursor-pointer hover:bg-surface-2 transition-all" style={{ fontFamily: 'inherit' }}>
          Cancel
        </button>
        <button onClick={handleSave} disabled={!name.trim() || !content.trim()} className="flex-1 py-3.5 rounded-[14px] border-none bg-accent-bright text-white text-[15px] font-600 cursor-pointer active:scale-[0.97] disabled:opacity-30 transition-all shadow-[0_4px_20px_rgba(99,102,241,0.25)] hover:brightness-110" style={{ fontFamily: 'inherit' }}>
          {editing ? 'Save' : 'Create'}
        </button>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        title="Delete Skill?"
        message={editing ? `Delete "${editing.name}"? This will remove it from all assigned agents.` : 'Delete this skill?'}
        confirmLabel={deleting ? 'Deleting...' : 'Delete'}
        confirmDisabled={deleting}
        cancelDisabled={deleting}
        danger
        onConfirm={() => { void handleDelete() }}
        onCancel={() => { if (!deleting) setConfirmDelete(false) }}
      />
    </BottomSheet>
  )
}
