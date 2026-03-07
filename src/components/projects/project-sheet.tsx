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
const sectionTitleClass = 'block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2'

function listToText(values?: string[]) {
  return Array.isArray(values) ? values.join('\n') : ''
}

function textToList(value: string) {
  return value
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function parseOptionalInteger(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const parsed = Number.parseInt(trimmed, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

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
  const [objective, setObjective] = useState('')
  const [audience, setAudience] = useState('')
  const [prioritiesText, setPrioritiesText] = useState('')
  const [openObjectivesText, setOpenObjectivesText] = useState('')
  const [capabilityHintsText, setCapabilityHintsText] = useState('')
  const [credentialRequirementsText, setCredentialRequirementsText] = useState('')
  const [successMetricsText, setSuccessMetricsText] = useState('')
  const [heartbeatPrompt, setHeartbeatPrompt] = useState('')
  const [heartbeatIntervalSec, setHeartbeatIntervalSec] = useState('')

  const editing = editingId ? projects[editingId] : null

  useEffect(() => {
    if (open) {
      if (editing) {
        setName(editing.name)
        setDescription(editing.description)
        setColor(editing.color)
        setObjective(editing.objective || '')
        setAudience(editing.audience || '')
        setPrioritiesText(listToText(editing.priorities))
        setOpenObjectivesText(listToText(editing.openObjectives))
        setCapabilityHintsText(listToText(editing.capabilityHints))
        setCredentialRequirementsText(listToText(editing.credentialRequirements))
        setSuccessMetricsText(listToText(editing.successMetrics))
        setHeartbeatPrompt(editing.heartbeatPrompt || '')
        setHeartbeatIntervalSec(editing.heartbeatIntervalSec ? String(editing.heartbeatIntervalSec) : '')
      } else {
        setName('')
        setDescription('')
        setColor(PROJECT_COLORS[0])
        setObjective('')
        setAudience('')
        setPrioritiesText('')
        setOpenObjectivesText('')
        setCapabilityHintsText('')
        setCredentialRequirementsText('')
        setSuccessMetricsText('')
        setHeartbeatPrompt('')
        setHeartbeatIntervalSec('')
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
      objective: objective.trim() || undefined,
      audience: audience.trim() || undefined,
      priorities: textToList(prioritiesText),
      openObjectives: textToList(openObjectivesText),
      capabilityHints: textToList(capabilityHintsText),
      credentialRequirements: textToList(credentialRequirementsText),
      successMetrics: textToList(successMetricsText),
      heartbeatPrompt: heartbeatPrompt.trim() || undefined,
      heartbeatIntervalSec: parseOptionalInteger(heartbeatIntervalSec),
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
    <BottomSheet open={open} onClose={onClose} wide>
      <h2 className="font-display text-[18px] font-700 text-text mb-6">{editing ? 'Edit Project' : 'New Project'}</h2>
      <div className="mb-6">
        <label className={sectionTitleClass}>Name</label>
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
        <label className={sectionTitleClass}>Description</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What is this project about?"
          className={inputClass + ' min-h-[80px] resize-y'}
          style={{ fontFamily: 'inherit' }}
          rows={3}
        />
      </div>

      <div className="grid gap-6 sm:grid-cols-2 mb-6">
        <div>
          <label className={sectionTitleClass}>Objective</label>
          <textarea
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            placeholder="What durable outcome is this project driving?"
            className={inputClass + ' min-h-[88px] resize-y'}
            style={{ fontFamily: 'inherit' }}
            rows={4}
          />
        </div>
        <div>
          <label className={sectionTitleClass}>Audience</label>
          <textarea
            value={audience}
            onChange={(e) => setAudience(e.target.value)}
            placeholder="Who is this project for?"
            className={inputClass + ' min-h-[88px] resize-y'}
            style={{ fontFamily: 'inherit' }}
            rows={4}
          />
        </div>
      </div>

      <div className="grid gap-6 sm:grid-cols-2 mb-6">
        <div>
          <label className={sectionTitleClass}>Pilot Priorities</label>
          <textarea
            value={prioritiesText}
            onChange={(e) => setPrioritiesText(e.target.value)}
            placeholder={'One per line\nResearch the market\nBuild the pilot'}
            className={inputClass + ' min-h-[110px] resize-y'}
            style={{ fontFamily: 'inherit' }}
            rows={5}
          />
          <p className="mt-2 text-[11px] text-text-3/45">One priority per line.</p>
        </div>
        <div>
          <label className={sectionTitleClass}>Open Objectives</label>
          <textarea
            value={openObjectivesText}
            onChange={(e) => setOpenObjectivesText(e.target.value)}
            placeholder={'One per line\nDraft the research brief\nPrepare the rollout checklist'}
            className={inputClass + ' min-h-[110px] resize-y'}
            style={{ fontFamily: 'inherit' }}
            rows={5}
          />
          <p className="mt-2 text-[11px] text-text-3/45">Use this for durable next outcomes, not one-off chat prompts.</p>
        </div>
      </div>

      <div className="grid gap-6 sm:grid-cols-2 mb-6">
        <div>
          <label className={sectionTitleClass}>Capability Hints</label>
          <textarea
            value={capabilityHintsText}
            onChange={(e) => setCapabilityHintsText(e.target.value)}
            placeholder={'One per line\nResearch\nWeb browsing\nInbox automation'}
            className={inputClass + ' min-h-[110px] resize-y'}
            style={{ fontFamily: 'inherit' }}
            rows={5}
          />
        </div>
        <div>
          <label className={sectionTitleClass}>Credential Requirements</label>
          <textarea
            value={credentialRequirementsText}
            onChange={(e) => setCredentialRequirementsText(e.target.value)}
            placeholder={'One per line\nGmail app password\nCRM API token'}
            className={inputClass + ' min-h-[110px] resize-y'}
            style={{ fontFamily: 'inherit' }}
            rows={5}
          />
        </div>
      </div>

      <div className="grid gap-6 sm:grid-cols-2 mb-6">
        <div>
          <label className={sectionTitleClass}>Success Metrics</label>
          <textarea
            value={successMetricsText}
            onChange={(e) => setSuccessMetricsText(e.target.value)}
            placeholder={'One per line\nReduce response time below 10 minutes\nIncrease qualified replies'}
            className={inputClass + ' min-h-[96px] resize-y'}
            style={{ fontFamily: 'inherit' }}
            rows={4}
          />
        </div>
        <div className="grid gap-4">
          <div>
            <label className={sectionTitleClass}>Heartbeat Prompt</label>
            <textarea
              value={heartbeatPrompt}
              onChange={(e) => setHeartbeatPrompt(e.target.value)}
              placeholder="What should the project heartbeat ask the agent to review?"
              className={inputClass + ' min-h-[72px] resize-y'}
              style={{ fontFamily: 'inherit' }}
              rows={3}
            />
          </div>
          <div>
            <label className={sectionTitleClass}>Heartbeat Interval (seconds)</label>
            <input
              type="number"
              min={0}
              step={60}
              value={heartbeatIntervalSec}
              onChange={(e) => setHeartbeatIntervalSec(e.target.value)}
              placeholder="1800"
              className={inputClass}
              style={{ fontFamily: 'inherit' }}
            />
          </div>
        </div>
      </div>

      <div className="mb-8">
        <label className={sectionTitleClass}>Color</label>
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
