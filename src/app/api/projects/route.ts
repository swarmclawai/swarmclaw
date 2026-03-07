import { NextResponse } from 'next/server'
import { genId } from '@/lib/id'
import { loadProjects, saveProjects } from '@/lib/server/storage'
import { ensureProjectWorkspace, normalizeProjectCreateInput } from '@/lib/server/project-utils'
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
  const normalized = normalizeProjectCreateInput(body && typeof body === 'object' ? body as Record<string, unknown> : {})
  projects[id] = {
    id,
    ...normalized,
    createdAt: now,
    updatedAt: now,
  }
  saveProjects(projects)
  ensureProjectWorkspace(id, projects[id].name)
  notify('projects')
  return NextResponse.json(projects[id])
}
