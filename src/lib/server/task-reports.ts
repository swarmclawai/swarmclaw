import fs from 'fs'
import path from 'path'
import type { BoardTask } from '@/types'

const REPORTS_DIR = path.join(process.cwd(), 'data', 'task-reports')
const MAX_REPORT_BODY = 6_000

const COMMAND_HINT = /\b(npm|pnpm|yarn|bun|node|npx|pytest|vitest|jest|playwright|go test|cargo test|deno test|python|pip|uv|docker|git)\b/i
const FILE_HINT = /\b([\w./-]+\.(ts|tsx|js|jsx|mjs|cjs|json|md|css|scss|html|yml|yaml|sh|py|go|rs|java|kt|swift|rb|php|sql))\b/i
const VERIFICATION_HINT = /\b(test|tests|passed|failed|failing|lint|typecheck|build|verified|verification)\b/i

export interface TaskReportEvidence {
  changedFiles: string[]
  commandsRun: string[]
  verification: string[]
  hasEvidence: boolean
}

export interface TaskReportArtifact {
  absolutePath: string
  relativePath: string
  evidence: TaskReportEvidence
}

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function toLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => normalizeLine(line.replace(/^[-*]\s+/, '')))
    .filter(Boolean)
}

function uniqueTop(values: string[], limit = 8): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
    if (out.length >= limit) break
  }
  return out
}

function extractEvidence(result: string): TaskReportEvidence {
  const lines = toLines(result)
  const changedFiles = uniqueTop(lines.filter((line) => FILE_HINT.test(line)))
  const commandsRun = uniqueTop(lines.filter((line) => COMMAND_HINT.test(line)))
  const verification = uniqueTop(lines.filter((line) => VERIFICATION_HINT.test(line)))

  return {
    changedFiles,
    commandsRun,
    verification,
    hasEvidence: changedFiles.length > 0 || commandsRun.length > 0 || verification.length > 0,
  }
}

function bullets(title: string, values: string[]): string[] {
  if (!values.length) return [`## ${title}`, '- Not provided', '']
  return [`## ${title}`, ...values.map((value) => `- ${value}`), '']
}

export function ensureTaskCompletionReport(task: Partial<BoardTask>): TaskReportArtifact | null {
  const id = typeof task.id === 'string' ? task.id.trim() : ''
  if (!id) return null

  const title = typeof task.title === 'string' && task.title.trim() ? task.title.trim() : 'Untitled Task'
  const description = typeof task.description === 'string' ? task.description.trim() : ''
  const result = typeof task.result === 'string' ? task.result.trim() : ''
  const evidence = extractEvidence(result)

  const reportPath = path.join(REPORTS_DIR, `${id}.md`)
  const relativePath = path.relative(process.cwd(), reportPath)
  const reportLines: string[] = [
    `# Task ${id}: ${title}`,
    '',
    `- Status: ${task.status || 'unknown'}`,
    `- Agent: ${task.agentId || 'unassigned'}`,
    `- Session: ${task.sessionId || 'none'}`,
    '',
  ]

  if (description) {
    reportLines.push('## Description')
    reportLines.push(description)
    reportLines.push('')
  }

  if (result) {
    reportLines.push('## Result Summary')
    reportLines.push(result.slice(0, MAX_REPORT_BODY))
    reportLines.push('')
  } else {
    reportLines.push('## Result Summary')
    reportLines.push('No result summary provided.')
    reportLines.push('')
  }

  reportLines.push(...bullets('Changed Files', evidence.changedFiles))
  reportLines.push(...bullets('Commands Run', evidence.commandsRun))
  reportLines.push(...bullets('Verification', evidence.verification))

  const content = `${reportLines.join('\n').trim()}\n`
  fs.mkdirSync(REPORTS_DIR, { recursive: true })
  const current = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf8') : null
  if (current !== content) {
    fs.writeFileSync(reportPath, content, 'utf8')
  }

  return {
    absolutePath: reportPath,
    relativePath,
    evidence,
  }
}
