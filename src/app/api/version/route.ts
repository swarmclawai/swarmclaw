import { NextResponse } from 'next/server'
import { gitAvailable, safeGit } from '@/lib/server/git-metadata'
import packageJson from '../../../../package.json'

export const dynamic = 'force-dynamic'

let cachedRemote: {
  sha: string
  behindBy: number
  channel: 'stable' | 'main'
  remoteTag: string | null
  checkedAt: number
} | null = null
const CACHE_TTL = 60_000
const RELEASE_TAG_RE = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

function getLatestStableTag(): string | null {
  const out = safeGit(['tag', '--list', 'v*', '--sort=-v:refname'])
  if (!out) return null
  return out.split('\n').map((l) => l.trim()).filter(Boolean).find((t) => RELEASE_TAG_RE.test(t)) || null
}

function getHeadStableTag(): string | null {
  const out = safeGit(['tag', '--points-at', 'HEAD', '--list', 'v*', '--sort=-v:refname'])
  if (!out) return null
  return out.split('\n').map((l) => l.trim()).filter(Boolean).find((t) => RELEASE_TAG_RE.test(t)) || null
}

export async function GET(_req: Request) {
  // Always return 200. When git metadata is unavailable (Docker production
  // image, npm tarball install) we fall back to the static package.json
  // version. Issue #41 reported a 500 response when `.git/` was not present
  // in the production container; this route now degrades gracefully.
  const packageVersion = packageJson.version

  if (!gitAvailable()) {
    return NextResponse.json({
      source: 'package',
      version: packageVersion,
      localSha: null,
      localTag: `v${packageVersion}`,
      remoteSha: null,
      remoteTag: null,
      channel: 'stable',
      updateAvailable: false,
      behindBy: 0,
    })
  }

  const localSha = safeGit(['rev-parse', '--short', 'HEAD'])
  const localTag = getHeadStableTag()

  let remoteSha = cachedRemote?.sha ?? localSha
  let behindBy = cachedRemote?.behindBy ?? 0
  let channel: 'stable' | 'main' = cachedRemote?.channel ?? 'main'
  let remoteTag = cachedRemote?.remoteTag ?? null

  if (!cachedRemote || Date.now() - cachedRemote.checkedAt > CACHE_TTL) {
    const fetched = safeGit(['fetch', '--tags', 'origin', '--quiet'])
    if (fetched !== null) {
      const latestTag = getLatestStableTag()
      if (latestTag) {
        channel = 'stable'
        remoteTag = latestTag
        const sha = safeGit(['rev-parse', '--short', `${latestTag}^{commit}`])
        if (sha) remoteSha = sha
        const count = safeGit(['rev-list', `HEAD..${latestTag}^{commit}`, '--count'])
        behindBy = count ? (parseInt(count, 10) || 0) : 0
      } else {
        channel = 'main'
        remoteTag = null
        safeGit(['fetch', 'origin', 'main', '--quiet'])
        const count = safeGit(['rev-list', 'HEAD..origin/main', '--count'])
        behindBy = count ? (parseInt(count, 10) || 0) : 0
        if (behindBy > 0) {
          const sha = safeGit(['rev-parse', '--short', 'origin/main'])
          if (sha) remoteSha = sha
        } else if (localSha) {
          remoteSha = localSha
        }
      }
      cachedRemote = { sha: remoteSha || '', behindBy, channel, remoteTag, checkedAt: Date.now() }
    }
  }

  return NextResponse.json({
    source: 'git',
    version: packageVersion,
    localSha,
    localTag,
    remoteSha,
    remoteTag,
    channel,
    updateAvailable: behindBy > 0,
    behindBy,
  })
}
