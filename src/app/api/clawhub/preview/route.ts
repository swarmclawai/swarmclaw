import { NextResponse } from 'next/server'
import { fetchSkillContent } from '@/lib/server/skills/clawhub-client'
import { normalizeSkillPayload } from '@/lib/server/skills/skills-normalize'

function validateHttpUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('url is required')
  }
  const parsed = new URL(value.trim())
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http/https URLs are supported')
  }
  return parsed.toString()
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const url = validateHttpUrl(body.url)
    const content = await fetchSkillContent(url)
    if (!content.trim()) {
      throw new Error('Fetched skill file is empty')
    }

    const normalized = normalizeSkillPayload({
      ...body,
      content,
      sourceUrl: url,
    })

    return NextResponse.json({
      name: normalized.name,
      filename: normalized.filename,
      description: normalized.description,
      content: normalized.content,
      sourceUrl: normalized.sourceUrl,
      sourceFormat: normalized.sourceFormat,
      author: normalized.author,
      tags: normalized.tags,
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
      invocation: normalized.invocation,
      commandDispatch: normalized.commandDispatch,
      frontmatter: normalized.frontmatter,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to preview skill'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
