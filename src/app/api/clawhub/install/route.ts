import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { loadSkills, saveSkills } from '@/lib/server/storage'
import { fetchSkillContent } from '@/lib/server/clawhub-client'

export async function POST(req: Request) {
  const body = await req.json()
  const { name, description, url, author, tags } = body
  let { content } = body

  if (!content) {
    try {
      content = await fetchSkillContent(url)
    } catch (err: any) {
      return NextResponse.json(
        { error: err.message || 'Failed to fetch skill content' },
        { status: 502 }
      )
    }
  }

  const skills = loadSkills()
  const id = crypto.randomBytes(4).toString('hex')
  skills[id] = {
    id,
    name,
    filename: `skill-${id}.md`,
    content,
    description: description || '',
    sourceFormat: 'openclaw',
    sourceUrl: url,
    author: author || '',
    tags: tags || [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  saveSkills(skills)
  return NextResponse.json(skills[id])
}
