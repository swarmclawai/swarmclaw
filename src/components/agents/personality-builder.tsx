'use client'

import { useEffect, useState } from 'react'
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

  useEffect(() => {
    if (fileType === 'IDENTITY.md') {
      const parsed = parseIdentityMd(content)
      setDraft({ name: parsed.name || '', creature: parsed.creature || '', vibe: parsed.vibe || '', emoji: parsed.emoji || '' })
    } else if (fileType === 'USER.md') {
      const parsed = parseUserMd(content)
      setDraft({ name: parsed.name || '', callThem: parsed.callThem || '', pronouns: parsed.pronouns || '', timezone: parsed.timezone || '', notes: parsed.notes || '', context: parsed.context || '' })
    } else if (fileType === 'SOUL.md') {
      const parsed = parseSoulMd(content)
      setDraft({ coreTruths: parsed.coreTruths || '', boundaries: parsed.boundaries || '', vibe: parsed.vibe || '', continuity: parsed.continuity || '' })
    }
  }, [content, fileType])

  const update = (key: string, value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }))
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
      <button
        onClick={handleSave}
        className="self-start px-4 py-1.5 rounded-[8px] border-none bg-accent-bright text-white text-[12px] font-600 cursor-pointer transition-all hover:brightness-110"
        style={{ fontFamily: 'inherit' }}
      >
        Apply to Raw Editor
      </button>
    </div>
  )
}
