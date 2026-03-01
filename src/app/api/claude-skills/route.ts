import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import os from 'os'
export const dynamic = 'force-dynamic'


/** GET /api/claude-skills — discover skills from ~/.claude/skills/ */
export async function GET(_req: Request) {
  const skillsDir = path.join(os.homedir(), '.claude', 'skills')
  const skills: { id: string; name: string; description: string }[] = []

  if (!fs.existsSync(skillsDir)) {
    return NextResponse.json(skills)
  }

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillMd = path.join(skillsDir, entry.name, 'SKILL.md')
    if (!fs.existsSync(skillMd)) continue

    try {
      const content = fs.readFileSync(skillMd, 'utf8')
      // Parse YAML frontmatter between --- markers
      const match = content.match(/^---\n([\s\S]*?)\n---/)
      if (!match) continue

      const frontmatter = match[1]
      const nameMatch = frontmatter.match(/^name:\s*(.+)$/m)
      const descMatch = frontmatter.match(/^description:\s*(.+)$/m)

      skills.push({
        id: entry.name,
        name: nameMatch?.[1]?.trim() || entry.name,
        description: descMatch?.[1]?.trim() || '',
      })
    } catch {
      // Skip malformed skill files
    }
  }

  return NextResponse.json(skills)
}
