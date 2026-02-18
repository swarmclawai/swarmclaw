import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { loadSkills, saveSkills } from '@/lib/server/storage'

export async function GET() {
  return NextResponse.json(loadSkills())
}

export async function POST(req: Request) {
  const body = await req.json()
  const skills = loadSkills()
  const id = crypto.randomBytes(4).toString('hex')
  skills[id] = {
    id,
    name: body.name || 'Unnamed Skill',
    filename: body.filename || `skill-${id}.md`,
    content: body.content || '',
    description: body.description || '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  saveSkills(skills)
  return NextResponse.json(skills[id])
}
