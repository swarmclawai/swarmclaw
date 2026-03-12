import { dedup } from '@/lib/shared-utils'

type GitHubIssueLabel = string | { name?: string | null }

export interface GitHubIssueRecord {
  id: number | string
  number: number
  title: string
  body?: string | null
  state?: string | null
  html_url?: string | null
  labels?: GitHubIssueLabel[]
  assignee?: { login?: string | null } | null
  user?: { login?: string | null } | null
  pull_request?: unknown
}

export interface ParsedRepo {
  owner: string
  repo: string
  fullName: string
}

const BODY_CHAR_LIMIT = 12_000

function normalizeLabelName(label: GitHubIssueLabel): string {
  if (typeof label === 'string') return label.trim()
  return String(label?.name || '').trim()
}

function normalizeTag(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, 60)
}

export function parseGitHubRepoInput(input: string): ParsedRepo | null {
  const trimmed = input.trim().replace(/\.git$/i, '')
  if (!trimmed) return null

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed)
      if (!/github\.com$/i.test(url.hostname)) return null
      const parts = url.pathname.split('/').filter(Boolean)
      if (parts.length < 2) return null
      const owner = parts[0]
      const repo = parts[1].replace(/\.git$/i, '')
      if (!owner || !repo) return null
      return { owner, repo, fullName: `${owner}/${repo}` }
    } catch {
      return null
    }
  }

  const compact = trimmed.replace(/^github\.com\//i, '')
  const parts = compact.split('/').filter(Boolean)
  if (parts.length < 2) return null
  const owner = parts[0]
  const repo = parts[1].replace(/\.git$/i, '')
  if (!owner || !repo) return null
  return { owner, repo, fullName: `${owner}/${repo}` }
}

export function buildGitHubIssueTaskTitle(issue: GitHubIssueRecord, repoFullName: string): string {
  const title = issue.title?.trim() || `Issue ${issue.number}`
  return `[${repoFullName}#${issue.number}] ${title}`
}

export function buildGitHubIssueTaskDescription(issue: GitHubIssueRecord, repoFullName: string): string {
  const labels = (issue.labels || [])
    .map(normalizeLabelName)
    .filter(Boolean)
  const header = [
    `Imported from GitHub issue ${repoFullName}#${issue.number}`,
    issue.html_url ? `URL: ${issue.html_url}` : '',
    issue.state ? `State: ${issue.state}` : '',
    labels.length > 0 ? `Labels: ${labels.join(', ')}` : '',
    issue.assignee?.login ? `Assignee: ${issue.assignee.login}` : '',
    issue.user?.login ? `Opened by: ${issue.user.login}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  const rawBody = String(issue.body || '').trim()
  if (!rawBody) return header

  const body = rawBody.length > BODY_CHAR_LIMIT
    ? `${rawBody.slice(0, BODY_CHAR_LIMIT).trimEnd()}\n\n[Truncated during import]`
    : rawBody

  return `${header}\n\n${body}`
}

export function buildGitHubIssueTaskTags(issue: GitHubIssueRecord, repoFullName: string): string[] {
  const raw = [
    'github',
    repoFullName,
    ...(issue.labels || []).map(normalizeLabelName),
  ]
  return dedup(raw.map(normalizeTag).filter(Boolean)).slice(0, 8)
}
