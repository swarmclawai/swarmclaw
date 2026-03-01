import type { PersonalityDraft } from '@/types'

// --- IDENTITY.md ---

export function parseIdentityMd(content: string): PersonalityDraft['identity'] {
  const result: PersonalityDraft['identity'] = {}
  const lines = content.split('\n')
  for (const line of lines) {
    const match = line.match(/^\s*-\s*(.+?):\s*(.+)$/)
    if (!match) continue
    const key = match[1].trim().toLowerCase()
    const value = match[2].trim()
    if (key === 'name') result.name = value
    else if (key === 'creature' || key === 'species' || key === 'type') result.creature = value
    else if (key === 'vibe' || key === 'personality') result.vibe = value
    else if (key === 'emoji' || key === 'icon') result.emoji = value
  }
  return result
}

export function serializeIdentityMd(draft: PersonalityDraft['identity']): string {
  const lines: string[] = ['# Identity', '']
  if (draft.name) lines.push(`- Name: ${draft.name}`)
  if (draft.creature) lines.push(`- Creature: ${draft.creature}`)
  if (draft.vibe) lines.push(`- Vibe: ${draft.vibe}`)
  if (draft.emoji) lines.push(`- Emoji: ${draft.emoji}`)
  return lines.join('\n') + '\n'
}

// --- USER.md ---

export function parseUserMd(content: string): PersonalityDraft['user'] {
  const result: PersonalityDraft['user'] = {}
  const contextIdx = content.indexOf('## Context')
  const headerPart = contextIdx >= 0 ? content.slice(0, contextIdx) : content
  const contextPart = contextIdx >= 0 ? content.slice(contextIdx + '## Context'.length).trim() : ''

  const lines = headerPart.split('\n')
  for (const line of lines) {
    const match = line.match(/^\s*-\s*(.+?):\s*(.+)$/)
    if (!match) continue
    const key = match[1].trim().toLowerCase()
    const value = match[2].trim()
    if (key === 'name') result.name = value
    else if (key === 'call them' || key === 'nickname') result.callThem = value
    else if (key === 'pronouns') result.pronouns = value
    else if (key === 'timezone') result.timezone = value
    else if (key === 'notes') result.notes = value
  }

  if (contextPart) result.context = contextPart

  return result
}

export function serializeUserMd(draft: PersonalityDraft['user']): string {
  const lines: string[] = ['# User', '']
  if (draft.name) lines.push(`- Name: ${draft.name}`)
  if (draft.callThem) lines.push(`- Call them: ${draft.callThem}`)
  if (draft.pronouns) lines.push(`- Pronouns: ${draft.pronouns}`)
  if (draft.timezone) lines.push(`- Timezone: ${draft.timezone}`)
  if (draft.notes) lines.push(`- Notes: ${draft.notes}`)
  if (draft.context) {
    lines.push('', '## Context', '', draft.context)
  }
  return lines.join('\n') + '\n'
}

// --- SOUL.md ---

export function parseSoulMd(content: string): PersonalityDraft['soul'] {
  const result: PersonalityDraft['soul'] = {}
  const sections = content.split(/^##\s+/m)

  for (const section of sections) {
    const nlIdx = section.indexOf('\n')
    if (nlIdx < 0) continue
    const heading = section.slice(0, nlIdx).trim().toLowerCase()
    const body = section.slice(nlIdx + 1).trim()

    if (heading.startsWith('core truth')) result.coreTruths = body
    else if (heading.startsWith('boundar')) result.boundaries = body
    else if (heading.startsWith('vibe')) result.vibe = body
    else if (heading.startsWith('continuity')) result.continuity = body
  }

  return result
}

export function serializeSoulMd(draft: PersonalityDraft['soul']): string {
  const lines: string[] = ['# Soul', '']
  if (draft.coreTruths) lines.push('## Core Truths', '', draft.coreTruths, '')
  if (draft.boundaries) lines.push('## Boundaries', '', draft.boundaries, '')
  if (draft.vibe) lines.push('## Vibe', '', draft.vibe, '')
  if (draft.continuity) lines.push('## Continuity', '', draft.continuity, '')
  return lines.join('\n')
}
