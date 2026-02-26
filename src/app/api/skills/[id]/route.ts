import { NextResponse } from 'next/server'
import { loadSkills, saveSkills, deleteSkill } from '@/lib/server/storage'
import { normalizeSkillPayload } from '@/lib/server/skills-normalize'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const skills = loadSkills()
  if (!skills[id]) return new NextResponse(null, { status: 404 })
  return NextResponse.json(skills[id])
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const skills = loadSkills()
  if (!skills[id]) return new NextResponse(null, { status: 404 })
  const normalized = normalizeSkillPayload({ ...skills[id], ...body })
  skills[id] = {
    ...skills[id],
    ...body,
    name: normalized.name,
    filename: normalized.filename,
    description: normalized.description,
    content: normalized.content,
    sourceUrl: normalized.sourceUrl,
    sourceFormat: normalized.sourceFormat,
    id,
    updatedAt: Date.now(),
  }
  saveSkills(skills)
  return NextResponse.json(skills[id])
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const skills = loadSkills()
  if (!skills[id]) return new NextResponse(null, { status: 404 })
  deleteSkill(id)
  return NextResponse.json({ deleted: id })
}
