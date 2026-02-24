import { NextResponse } from 'next/server'
import { execSync } from 'child_process'

let cachedRemote: {
  sha: string
  behindBy: number
  channel: 'stable' | 'main'
  remoteTag: string | null
  checkedAt: number
} | null = null
const CACHE_TTL = 60_000 // 60s
const RELEASE_TAG_RE = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

function run(cmd: string): string {
  return execSync(cmd, { encoding: 'utf-8', cwd: process.cwd(), timeout: 15_000 }).trim()
}

function getLatestStableTag(): string | null {
  const tags = run(`git tag --list 'v*' --sort=-v:refname`)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return tags.find((tag) => RELEASE_TAG_RE.test(tag)) || null
}

function getHeadStableTag(): string | null {
  const tags = run(`git tag --points-at HEAD --list 'v*' --sort=-v:refname`)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return tags.find((tag) => RELEASE_TAG_RE.test(tag)) || null
}

export async function GET() {
  try {
    const localSha = run('git rev-parse --short HEAD')
    const localTag = getHeadStableTag()

    let remoteSha = cachedRemote?.sha ?? localSha
    let behindBy = cachedRemote?.behindBy ?? 0
    let channel: 'stable' | 'main' = cachedRemote?.channel ?? 'main'
    let remoteTag = cachedRemote?.remoteTag ?? null

    if (!cachedRemote || Date.now() - cachedRemote.checkedAt > CACHE_TTL) {
      try {
        run('git fetch --tags origin --quiet')
        const latestTag = getLatestStableTag()
        if (latestTag) {
          channel = 'stable'
          remoteTag = latestTag
          remoteSha = run(`git rev-parse --short ${latestTag}^{commit}`)
          behindBy = parseInt(run(`git rev-list HEAD..${latestTag}^{commit} --count`), 10) || 0
        } else {
          // Fallback for repos without release tags yet.
          channel = 'main'
          remoteTag = null
          run('git fetch origin main --quiet')
          behindBy = parseInt(run('git rev-list HEAD..origin/main --count'), 10) || 0
          remoteSha = behindBy > 0
            ? run('git rev-parse --short origin/main')
            : localSha
        }
        cachedRemote = { sha: remoteSha, behindBy, channel, remoteTag, checkedAt: Date.now() }
      } catch {
        // fetch failed (no network, no remote, etc.) — use stale cache or defaults
      }
    }

    return NextResponse.json({
      localSha,
      localTag,
      remoteSha,
      remoteTag,
      channel,
      updateAvailable: behindBy > 0,
      behindBy,
    })
  } catch {
    return NextResponse.json({ error: 'Not a git repository' }, { status: 500 })
  }
}
