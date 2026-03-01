import { NextResponse } from 'next/server'
import { loadProjects, saveProjects, deleteProject, loadAgents, saveAgents, loadTasks, saveTasks, loadSchedules, saveSchedules, loadSkills, saveSkills } from '@/lib/server/storage'
import { mutateItem, deleteItem, notFound, type CollectionOps } from '@/lib/server/collection-helpers'
import { notify } from '@/lib/server/ws-hub'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ops: CollectionOps<any> = { load: loadProjects, save: saveProjects, deleteFn: deleteProject, topic: 'projects' }

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const projects = loadProjects()
  if (!projects[id]) return notFound()
  return NextResponse.json(projects[id])
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const result = mutateItem(ops, id, (project) => {
    Object.assign(project, body, { updatedAt: Date.now() })
    delete (project as Record<string, unknown>).id
    project.id = id
    return project
  })
  if (!result) return notFound()
  return NextResponse.json(result)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!deleteItem(ops, id)) return notFound()

  // Clear projectId from referencing entities
  const clearProjectId = (load: () => Record<string, Record<string, unknown>>, save: (d: Record<string, Record<string, unknown>>) => void, topic: string) => {
    const items = load()
    let changed = false
    for (const item of Object.values(items)) {
      if (item.projectId === id) {
        item.projectId = undefined
        changed = true
      }
    }
    if (changed) {
      save(items)
      notify(topic)
    }
  }

  clearProjectId(loadAgents, saveAgents, 'agents')
  clearProjectId(loadTasks, saveTasks, 'tasks')
  clearProjectId(loadSchedules, saveSchedules, 'schedules')
  clearProjectId(loadSkills, saveSkills, 'skills')

  return NextResponse.json({ ok: true })
}
