import { NextResponse } from 'next/server'
import { execSync } from 'child_process'

const RELEASE_TAG_RE = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

function run(cmd: string): string {
  return execSync(cmd, { encoding: 'utf-8', cwd: process.cwd(), timeout: 60_000 }).trim()
}

function getLatestStableTag(): string | null {
  const tags = run(`git tag --list 'v*' --sort=-v:refname`)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return tags.find((tag) => RELEASE_TAG_RE.test(tag)) || null
}

function ensureCleanWorkingTree() {
  const dirty = run('git status --porcelain')
  if (dirty) {
    throw new Error('Local changes detected. Commit/stash them first, then retry update.')
  }
}

export async function POST() {
  try {
    const beforeSha = run('git rev-parse --short HEAD')
    const beforeRef = run('git rev-parse HEAD')
    const currentBranch = run('git rev-parse --abbrev-ref HEAD')
    let pullOutput = ''
    let channel: 'stable' | 'main' = 'main'
    let targetTag: string | null = null
    let switchedToStable = false

    // Prefer latest stable release tags when available.
    try {
      run('git fetch --tags origin --quiet')
      const latestTag = getLatestStableTag()
      if (latestTag) {
        channel = 'stable'
        targetTag = latestTag
        const targetRef = `${latestTag}^{commit}`
        const targetSha = run(`git rev-parse ${targetRef}`)
        if (targetSha !== beforeRef) {
          ensureCleanWorkingTree()
          // Keep end-user installs on a predictable "stable" branch that tracks release tags.
          run(`git checkout -B stable ${targetRef}`)
          switchedToStable = currentBranch !== 'stable'
          pullOutput = `Updated to stable release ${latestTag}.`
        } else {
          pullOutput = `Already on latest stable release ${latestTag}.`
        }
      }
    } catch {
      // If stable-tag flow fails, fallback to main.
      channel = 'main'
      targetTag = null
    }

    if (channel === 'main') {
      // Fallback for repos without release tags.
      pullOutput = run('git pull --ff-only origin main')
    }

    // Check if package-lock.json changed in the pull
    let installedDeps = false
    try {
      const diff = run(`git diff --name-only ${beforeSha}..HEAD`)
      if (diff.includes('package-lock.json') || diff.includes('package.json')) {
        run('npm install --omit=dev')
        installedDeps = true
      }
    } catch {
      // If diff fails (e.g. first commit), skip install check
    }

    const newSha = run('git rev-parse --short HEAD')

    return NextResponse.json({
      success: true,
      newSha,
      pullOutput,
      installedDeps,
      channel,
      targetTag,
      switchedToStable,
      needsRestart: true,
    })
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : 'Update failed' },
      { status: 500 }
    )
  }
}
