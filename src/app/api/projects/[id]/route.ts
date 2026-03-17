import { NextResponse } from 'next/server'
import { notFound } from '@/lib/server/collection-helpers'
import { deleteProjectAndDetachReferences, getProject, updateProject } from '@/lib/server/projects/project-service'
import { safeParseBody } from '@/lib/server/safe-parse-body'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const project = getProject(id)
  if (!project) return notFound()
  return NextResponse.json(project)
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { data: body, error } = await safeParseBody<Record<string, unknown>>(req)
  if (error) return error
  const result = updateProject(id, body && typeof body === 'object' ? body : {})
  if (!result) return notFound()
  return NextResponse.json(result)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!deleteProjectAndDetachReferences(id)) return notFound()
  return NextResponse.json({ ok: true })
}
