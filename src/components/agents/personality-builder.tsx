'use client'

import { useEffect, useMemo, useState } from 'react'
import type { PersonalityDraft } from '@/types'
import { api } from '@/lib/api-client'
import {
  parseIdentityMd, serializeIdentityMd,
  parseUserMd, serializeUserMd,
  parseSoulMd, serializeSoulMd,
} from '@/lib/personality-parser'

interface Props {
  agentId: string
  fileType: 'IDENTITY.md' | 'USER.md' | 'SOUL.md'
  content: string
  onSave: (content: string) => void
}

const inputClass = 'w-full px-3 py-2 rounded-[10px] border border-white/[0.06] bg-black/20 text-[13px] text-text outline-none placeholder:text-text-3/40 focus:border-white/[0.12] transition-colors'
const labelClass = 'block text-[11px] font-600 uppercase tracking-wider text-text-3/50 mb-1'

export function PersonalityBuilder({ agentId: _agentId, fileType, content, onSave }: Props) {
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [initialDraft, setInitialDraft] = useState<Record<string, string>>({})
  const [saveState, setSaveState] = useState<'idle' | 'saved'>('idle')

  useEffect(() => {
    let parsed: Record<string, string> = {}
    if (fileType === 'IDENTITY.md') {
      const p = parseIdentityMd(content)
      parsed = { name: p.name || '', creature: p.creature || '', vibe: p.vibe || '', emoji: p.emoji || '' }
    } else if (fileType === 'USER.md') {
      const p = parseUserMd(content)
      parsed = { name: p.name || '', callThem: p.callThem || '', pronouns: p.pronouns || '', timezone: p.timezone || '', notes: p.notes || '', context: p.context || '' }
    } else if (fileType === 'SOUL.md') {
      const p = parseSoulMd(content)
      parsed = { coreTruths: p.coreTruths || '', boundaries: p.boundaries || '', vibe: p.vibe || '', continuity: p.continuity || '' }
    }
    setDraft(parsed)
    setInitialDraft(parsed)
    setSaveState('idle')
  }, [content, fileType])

  const isDirty = useMemo(() => {
    return Object.keys(draft).some((k) => draft[k] !== (initialDraft[k] ?? ''))
  }, [draft, initialDraft])

  const update = (key: string, value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }))
    setSaveState('idle')
  }

  const handleSave = () => {
    let serialized = ''
    if (fileType === 'IDENTITY.md') {
      serialized = serializeIdentityMd(draft as PersonalityDraft['identity'])
    } else if (fileType === 'USER.md') {
      serialized = serializeUserMd(draft as PersonalityDraft['user'])
    } else if (fileType === 'SOUL.md') {
      serialized = serializeSoulMd(draft as PersonalityDraft['soul'])
    }
    onSave(serialized)
    setInitialDraft({ ...draft })
    setSaveState('saved')
    setTimeout(() => setSaveState('idle'), 1500)
  }

  const fields = fileType === 'IDENTITY.md'
    ? [
        { key: 'name', label: 'Name', placeholder: 'Agent display name' },
        { key: 'creature', label: 'Creature / Type', placeholder: 'e.g. fox, robot, wizard' },
        { key: 'vibe', label: 'Vibe', placeholder: 'e.g. calm, energetic, mysterious' },
        { key: 'emoji', label: 'Emoji / Icon', placeholder: 'e.g. a single emoji' },
      ]
    : fileType === 'USER.md'
    ? [
        { key: 'name', label: 'User Name', placeholder: 'Your name' },
        { key: 'callThem', label: 'Call Them', placeholder: 'Nickname / preferred name' },
        { key: 'pronouns', label: 'Pronouns', placeholder: 'e.g. they/them' },
        { key: 'timezone', label: 'Timezone', placeholder: 'e.g. America/New_York' },
        { key: 'notes', label: 'Notes', placeholder: 'Quick notes' },
        { key: 'context', label: 'Context', placeholder: 'Additional context...', multiline: true },
      ]
    : [
        { key: 'coreTruths', label: 'Core Truths', placeholder: 'What the agent believes...', multiline: true },
        { key: 'boundaries', label: 'Boundaries', placeholder: 'What the agent won\'t do...', multiline: true },
        { key: 'vibe', label: 'Vibe', placeholder: 'Personality tone and style...', multiline: true },
        { key: 'continuity', label: 'Continuity', placeholder: 'What persists between sessions...', multiline: true },
      ]

  return (
    <div className="flex flex-col gap-3">
      {fields.map((f) => (
        <div key={f.key}>
          <label className={labelClass}>{f.label}</label>
          {'multiline' in f && f.multiline ? (
            <textarea
              value={draft[f.key] || ''}
              onChange={(e) => update(f.key, e.target.value)}
              placeholder={f.placeholder}
              rows={3}
              className={`${inputClass} resize-none`}
              style={{ fontFamily: 'ui-monospace, monospace' }}
            />
          ) : (
            <input
              type="text"
              value={draft[f.key] || ''}
              onChange={(e) => update(f.key, e.target.value)}
              placeholder={f.placeholder}
              className={inputClass}
            />
          )}
        </div>
      ))}
      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          className="self-start px-4 py-1.5 rounded-[8px] border-none bg-accent-bright text-white text-[12px] font-600 cursor-pointer transition-all hover:brightness-110 focus-visible:ring-1 focus-visible:ring-accent-bright/50"
          style={{ fontFamily: 'inherit' }}
        >
          Apply to Raw Editor
        </button>
        {isDirty && saveState === 'idle' && (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-amber-400 font-600">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            Unsaved
          </span>
        )}
        {saveState === 'saved' && (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-emerald-400 font-600">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12" /></svg>
            Saved
          </span>
        )}
      </div>
    </div>
  )
}
