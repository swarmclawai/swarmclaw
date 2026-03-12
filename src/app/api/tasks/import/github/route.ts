import { NextResponse } from 'next/server'
import { z } from 'zod'
import { genId } from '@/lib/id'
import { computeTaskFingerprint } from '@/lib/task-dedupe'
import { formatZodError } from '@/lib/validation/schemas'
import { loadSettings, loadTasks, logActivity, upsertStoredItems } from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'
import type { BoardTask } from '@/types'
import { parseGitHubRepoInput, buildGitHubIssueTaskTitle, buildGitHubIssueTaskDescription, buildGitHubIssueTaskTags } from './helpers'
import type { GitHubIssueRecord } from './helpers'

const MAX_IMPORT_LIMIT = 200

const GitHubIssueImportSchema = z.object({
  repo: z.string().trim().min(1, 'Repository is required'),
  token: z.string().trim().optional().default(''),
  state: z.enum(['open', 'closed', 'all']).optional().default('open'),
  limit: z.coerce.number().int().min(1).max(MAX_IMPORT_LIMIT).optional().default(25),
  labels: z.array(z.string()).optional().default([]),
  projectId: z.string().trim().nullable().optional().default(null),
  agentId: z.string().trim().nullable().optional().default(null),
})

type GitHubIssueLabel = string | { name?: string | null }

function getGitHubToken(explicitToken: string): string {
  return explicitToken.trim()
    || process.env.GITHUB_TOKEN
    || process.env.GH_TOKEN
    || process.env.GITHUB_PERSONAL_ACCESS_TOKEN
    || ''
}

function normalizeLabelName(label: GitHubIssueLabel): string {
  if (typeof label === 'string') return label.trim()
  return String(label?.name || '').trim()
}

function toIssueSummary(issue: GitHubIssueRecord, taskId?: string) {
  return {
    taskId,
    number: issue.number,
    title: issue.title || `Issue ${issue.number}`,
    url: issue.html_url || null,
  }
}

function findExistingImportedTask(
  tasks: Record<string, BoardTask>,
  repoFullName: string,
  issueNumber: number,
): BoardTask | null {
  for (const task of Object.values(tasks)) {
    if (task.sourceType !== 'import') continue
    if (task.externalSource?.source !== 'github') continue
    if (task.externalSource?.repo !== repoFullName) continue
    if (task.externalSource?.number !== issueNumber) continue
    return task
  }
  return null
}

async function fetchGitHubIssues(args: {
  owner: string
  repo: string
  state: 'open' | 'closed' | 'all'
  limit: number
  labels: string[]
  token: string
}): Promise<GitHubIssueRecord[]> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'SwarmClaw',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (args.token) headers.Authorization = `Bearer ${args.token}`

  const results: GitHubIssueRecord[] = []
  const perPage = Math.min(100, Math.max(30, args.limit))
  const maxPages = Math.max(1, Math.ceil(args.limit / 100) + 2)

  for (let page = 1; page <= maxPages && results.length < args.limit; page++) {
    const url = new URL(`https://api.github.com/repos/${args.owner}/${args.repo}/issues`)
    url.searchParams.set('state', args.state)
    url.searchParams.set('per_page', String(perPage))
    url.searchParams.set('page', String(page))
    if (args.labels.length > 0) url.searchParams.set('labels', args.labels.join(','))

    const response = await fetch(url, {
      headers,
      cache: 'no-store',
    })

    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { message?: unknown } | null
      const message = typeof payload?.message === 'string'
        ? payload.message
        : `GitHub request failed (${response.status})`
      const err = new Error(message) as Error & { status?: number }
      err.status = response.status
      throw err
    }

    const payload = await response.json().catch(() => null) as unknown
    if (!Array.isArray(payload)) {
      throw new Error('GitHub returned an unexpected response.')
    }

    const pageIssues = payload
      .filter((entry): entry is GitHubIssueRecord => !!entry && typeof entry === 'object')
      .filter((entry) => !entry.pull_request)

    results.push(...pageIssues)
    if (payload.length < perPage) break
  }

  return results.slice(0, args.limit)
}

export async function POST(req: Request) {
  const raw = await req.json().catch(() => null)
  const parsed = GitHubIssueImportSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(formatZodError(parsed.error), { status: 400 })
  }

  const repo = parseGitHubRepoInput(parsed.data.repo)
  if (!repo) {
    return NextResponse.json({ error: 'Use a GitHub repo like owner/repo or a github.com URL.' }, { status: 400 })
  }

  const labels = parsed.data.labels
    .map((value) => String(value || '').trim())
    .filter(Boolean)

  let issues: GitHubIssueRecord[]
  try {
    issues = await fetchGitHubIssues({
      owner: repo.owner,
      repo: repo.repo,
      state: parsed.data.state,
      limit: parsed.data.limit,
      labels,
      token: getGitHubToken(parsed.data.token),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'GitHub import failed.'
    const status = typeof (err as { status?: unknown })?.status === 'number'
      ? Number((err as { status?: number }).status)
      : 500
    const responseStatus = [400, 401, 403, 404, 429].includes(status) ? status : 502
    return NextResponse.json({ error: message }, { status: responseStatus })
  }

  const tasks = loadTasks() as Record<string, BoardTask>
  const settings = loadSettings()
  const now = Date.now()
  const maxAttempts = Math.max(1, Math.min(20, Math.trunc(Number(settings.defaultTaskMaxAttempts ?? 3))))
  const retryBackoffSec = Math.max(1, Math.min(3600, Math.trunc(Number(settings.taskRetryBackoffSec ?? 30))))
  const projectId = parsed.data.projectId || undefined
  const agentId = parsed.data.agentId || ''

  const created: Array<ReturnType<typeof toIssueSummary>> = []
  const skipped: Array<ReturnType<typeof toIssueSummary>> = []
  const taskEntries: Array<[string, BoardTask]> = []

  for (const issue of issues) {
    const existing = findExistingImportedTask(tasks, repo.fullName, issue.number)
    if (existing) {
      skipped.push(toIssueSummary(issue, existing.id))
      continue
    }

    const id = genId()
    const title = buildGitHubIssueTaskTitle(issue, repo.fullName)
    const task: BoardTask = {
      id,
      title,
      description: buildGitHubIssueTaskDescription(issue, repo.fullName),
      status: 'backlog',
      agentId,
      projectId,
      result: null,
      error: null,
      outputFiles: [],
      artifacts: [],
      createdAt: now,
      updatedAt: now,
      queuedAt: null,
      startedAt: null,
      completedAt: null,
      archivedAt: null,
      attempts: 0,
      maxAttempts,
      retryBackoffSec,
      retryScheduledAt: null,
      deadLetteredAt: null,
      checkpoint: null,
      blockedBy: [],
      blocks: [],
      tags: buildGitHubIssueTaskTags(issue, repo.fullName),
      sourceType: 'import',
      externalSource: {
        source: 'github',
        id: String(issue.id),
        repo: repo.fullName,
        number: issue.number,
        state: issue.state || null,
        labels: (issue.labels || []).map(normalizeLabelName).filter(Boolean),
        assignee: issue.assignee?.login || null,
        url: issue.html_url || null,
      },
      fingerprint: computeTaskFingerprint(title, agentId),
    }

    tasks[id] = task
    taskEntries.push([id, task])
    created.push(toIssueSummary(issue, id))
  }

  if (taskEntries.length > 0) {
    upsertStoredItems('tasks', taskEntries)
    notify('tasks')
  }

  logActivity({
    entityType: 'task',
    entityId: created[0]?.taskId || `github:${repo.fullName}`,
    action: 'imported',
    actor: 'user',
    summary: `GitHub import from ${repo.fullName}: ${created.length} created, ${skipped.length} skipped`,
    detail: {
      repo: repo.fullName,
      state: parsed.data.state,
      labels,
      created: created.length,
      skipped: skipped.length,
    },
  })

  return NextResponse.json({
    repo: repo.fullName,
    state: parsed.data.state,
    fetched: issues.length,
    created,
    skipped,
  })
}
