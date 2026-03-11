import { NextResponse } from 'next/server'
import { loadSkills, saveSkills, deleteSkill } from '@/lib/server/storage'
import { normalizeSkillPayload } from '@/lib/server/skills/skills-normalize'
import { mutateItem, deleteItem, notFound, type CollectionOps } from '@/lib/server/collection-helpers'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ops: CollectionOps<any> = { load: loadSkills, save: saveSkills, deleteFn: deleteSkill }

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const skills = loadSkills()
  if (!skills[id]) return notFound()
  return NextResponse.json(skills[id])
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const result = mutateItem(ops, id, (skill) => {
    const normalized = normalizeSkillPayload({ ...skill, ...body })
    const updatedScope = body.scope === 'agent' ? 'agent' as const : body.scope === 'global' ? 'global' as const : skill.scope
    const updatedAgentIds = updatedScope === 'agent' && Array.isArray(body.agentIds)
      ? (body.agentIds as unknown[]).filter((aid): aid is string => typeof aid === 'string')
      : updatedScope === 'agent' ? (skill.agentIds || []) : []
    return {
      ...skill,
      ...body,
      name: normalized.name,
      filename: normalized.filename,
      description: normalized.description,
      content: normalized.content,
      sourceUrl: normalized.sourceUrl,
      sourceFormat: normalized.sourceFormat,
      author: normalized.author ?? skill.author,
      tags: normalized.tags ?? skill.tags,
      version: normalized.version ?? null,
      homepage: normalized.homepage ?? null,
      primaryEnv: normalized.primaryEnv ?? null,
      skillKey: normalized.skillKey ?? null,
      toolNames: normalized.toolNames,
      capabilities: normalized.capabilities,
      always: typeof normalized.always === 'boolean' ? normalized.always : false,
      installOptions: normalized.installOptions,
      skillRequirements: normalized.skillRequirements,
      detectedEnvVars: normalized.detectedEnvVars,
      security: normalized.security,
      invocation: normalized.invocation,
      commandDispatch: normalized.commandDispatch,
      frontmatter: normalized.frontmatter,
      scope: updatedScope,
      agentIds: updatedAgentIds,
      id,
      updatedAt: Date.now(),
    }
  })
  if (!result) return notFound()
  return NextResponse.json(result)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!deleteItem(ops, id)) return notFound()
  return NextResponse.json({ deleted: id })
}
