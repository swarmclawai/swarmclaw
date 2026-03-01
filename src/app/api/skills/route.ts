import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { loadSkills, saveSkills } from '@/lib/server/storage'
import { normalizeSkillPayload } from '@/lib/server/skills-normalize'
export const dynamic = 'force-dynamic'


export async function GET(_req: Request) {
  return NextResponse.json(loadSkills())
}

export async function POST(req: Request) {
  const body = await req.json()
  const skills = loadSkills()
  const id = crypto.randomBytes(4).toString('hex')
  const normalized = normalizeSkillPayload(body)
  skills[id] = {
    id,
    name: normalized.name,
    filename: normalized.filename || `skill-${id}.md`,
    content: normalized.content || '',
    description: normalized.description || '',
    sourceUrl: normalized.sourceUrl,
    sourceFormat: normalized.sourceFormat,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  saveSkills(skills)
  return NextResponse.json(skills[id])
}
