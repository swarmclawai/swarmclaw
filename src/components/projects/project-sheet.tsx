'use client'

import { useEffect, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { createProject, updateProject, deleteProject } from '@/lib/projects'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import { toast } from 'sonner'

const PROJECT_COLORS = [
  '#EF4444', '#F97316', '#EAB308', '#22C55E', '#06B6D4',
  '#3B82F6', '#8B5CF6', '#EC4899', '#6B7280',
]

const inputClass = 'w-full px-3 py-2.5 rounded-lg bg-white/[0.06] border border-white/[0.06] text-[13px] text-text-1 placeholder:text-text-3/40 focus:outline-none focus:border-accent/40 transition-colors'

export function ProjectSheet() {
  const open = useAppStore((s) => s.projectSheetOpen)
  const setOpen = useAppStore((s) => s.setProjectSheetOpen)
  const editingId = useAppStore((s) => s.editingProjectId)
  const setEditingId = useAppStore((s) => s.setEditingProjectId)
  const projects = useAppStore((s) => s.projects)
  const loadProjects = useAppStore((s) => s.loadProjects)

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState<string | undefined>(undefined)

  const editing = editingId ? projects[editingId] : null

  useEffect(() => {
    if (open) {
      if (editing) {
        setName(editing.name)
        setDescription(editing.description)
        setColor(editing.color)
      } else {
        setName('')
        setDescription('')
        setColor(PROJECT_COLORS[0])
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editingId])

  const onClose = () => {
    setOpen(false)
    setEditingId(null)
  }

  const handleSave = async () => {
    const data = {
      name: name.trim() || 'Unnamed Project',
      description,
      color,
    }
    if (editing) {
      await updateProject(editing.id, data)
    } else {
      await createProject(data)
    }
    await loadProjects()
    onClose()
  }

  const handleDelete = async () => {
    if (editing) {
      await deleteProject(editing.id)
      await loadProjects()
      onClose()
      toast.success('Project deleted')
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose}>
      <h2 className="font-display text-[18px] font-700 text-text mb-6">{editing ? 'Edit Project' : 'New Project'}</h2>
      <div className="mb-6">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Marketing Site"
          className={inputClass}
          style={{ fontFamily: 'inherit' }}
          autoFocus
        />
      </div>

      <div className="mb-6">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">Description</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What is this project about?"
          className={inputClass + ' min-h-[80px] resize-y'}
          style={{ fontFamily: 'inherit' }}
          rows={3}
        />
      </div>

      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">Color</label>
        <div className="flex items-center gap-2">
          {PROJECT_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              className={`w-7 h-7 rounded-full transition-all ${color === c ? 'ring-2 ring-offset-2 ring-offset-surface ring-accent scale-110' : 'hover:scale-105'}`}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          className="flex-1 py-2.5 rounded-lg bg-accent text-white text-[13px] font-600 hover:bg-accent-bright transition-colors"
        >
          {editing ? 'Update' : 'Create'} Project
        </button>
        {editing && (
          <button
            onClick={handleDelete}
            className="px-4 py-2.5 rounded-lg bg-red-500/10 text-red-400 text-[13px] font-600 hover:bg-red-500/20 transition-colors"
          >
            Delete
          </button>
        )}
      </div>
    </BottomSheet>
  )
}
