import { NextResponse } from 'next/server'
import { loadSkills, saveSkills } from '@/lib/server/storage'

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
  skills[id] = { ...skills[id], ...body, id, updatedAt: Date.now() }
  saveSkills(skills)
  return NextResponse.json(skills[id])
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const skills = loadSkills()
  if (!skills[id]) return new NextResponse(null, { status: 404 })
  delete skills[id]
  saveSkills(skills)
  return NextResponse.json({ ok: true })
}
