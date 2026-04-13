import { execFileSync } from 'node:child_process'

/**
 * Pure helpers for reading git metadata at runtime, with graceful degradation
 * when the working directory is not a git checkout (Docker production image,
 * npm tarball install, etc.).
 *
 * Always uses `execFileSync` with an arg array (no shell) so user input cannot
 * influence the command line.
 */
export function safeGit(args: string[], cwd: string = process.cwd()): string | null {
  try {
    const out = execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return typeof out === 'string' ? out.trim() : null
  } catch {
    return null
  }
}

let cachedAvailable: boolean | null = null

/**
 * Returns true when the current working directory looks like a git checkout
 * (i.e. `git rev-parse --git-dir` succeeds). Cached for the lifetime of the
 * process, since the answer does not change while a server is running.
 *
 * Exported `resetGitAvailableCache` is for unit tests only.
 */
export function gitAvailable(): boolean {
  if (cachedAvailable !== null) return cachedAvailable
  cachedAvailable = safeGit(['rev-parse', '--git-dir']) !== null
  return cachedAvailable
}

export function resetGitAvailableCache(): void {
  cachedAvailable = null
}
