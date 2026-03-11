import { NextResponse } from 'next/server'
import { genId } from '@/lib/id'
import { loadSkills, saveSkills } from '@/lib/server/storage'
import { fetchSkillContent } from '@/lib/server/skills/clawhub-client'
import { normalizeSkillPayload } from '@/lib/server/skills/skills-normalize'

export async function POST(req: Request) {
  const body = await req.json()
  const { name, description, url, author, tags } = body
  let { content } = body

  if (!content) {
    try {
      content = await fetchSkillContent(url)
    } catch (err: unknown) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Failed to fetch skill content' },
        { status: 502 }
      )
    }
  }

  const normalized = normalizeSkillPayload({
    name,
    description,
    content,
    sourceUrl: url,
    author,
    tags,
  })

  const skills = loadSkills()
  const id = genId()
  skills[id] = {
    id,
    name: normalized.name,
    filename: normalized.filename || `skill-${id}.md`,
    content: normalized.content,
    description: normalized.description || '',
    sourceFormat: normalized.sourceFormat,
    sourceUrl: normalized.sourceUrl,
    author: normalized.author || '',
    tags: normalized.tags || [],
    version: normalized.version,
    homepage: normalized.homepage,
    primaryEnv: normalized.primaryEnv,
    skillKey: normalized.skillKey,
    toolNames: normalized.toolNames,
    capabilities: normalized.capabilities,
    always: normalized.always,
    installOptions: normalized.installOptions,
    skillRequirements: normalized.skillRequirements,
    detectedEnvVars: normalized.detectedEnvVars,
    security: normalized.security,
    frontmatter: normalized.frontmatter,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  saveSkills(skills)
  return NextResponse.json(skills[id])
}
