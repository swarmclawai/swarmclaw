import { NextResponse } from 'next/server'
import { genId } from '@/lib/id'
import { loadProjects, saveProjects } from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'
export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(loadProjects())
}

export async function POST(req: Request) {
  const body = await req.json()
  const id = genId()
  const now = Date.now()
  const projects = loadProjects()
  projects[id] = {
    id,
    name: body.name || 'Unnamed Project',
    description: body.description || '',
    color: body.color || undefined,
    createdAt: now,
    updatedAt: now,
  }
  saveProjects(projects)
  notify('projects')
  return NextResponse.json(projects[id])
}
