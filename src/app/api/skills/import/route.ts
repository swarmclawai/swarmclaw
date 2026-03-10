import { NextResponse } from 'next/server'
import { normalizeSkillPayload } from '@/lib/server/skills/skills-normalize'

const MAX_SKILL_BYTES = 2 * 1024 * 1024

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

    const res = await fetch(url, {
      signal: AbortSignal.timeout(20_000),
      headers: {
        'User-Agent': 'SwarmClaw/1.0 skill-import',
      },
    })

    if (!res.ok) {
      throw new Error(`Failed to fetch skill (${res.status})`)
    }

    const content = await res.text()
    if (!content.trim()) {
      throw new Error('Fetched skill file is empty')
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_SKILL_BYTES) {
      throw new Error('Skill file too large (max 2MB)')
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
      always: normalized.always,
      installOptions: normalized.installOptions,
      skillRequirements: normalized.skillRequirements,
      detectedEnvVars: normalized.detectedEnvVars,
      security: normalized.security,
      frontmatter: normalized.frontmatter,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to import skill'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
