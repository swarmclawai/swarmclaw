import { spawnSync } from 'node:child_process'

interface DockerStatus {
  available: boolean
  version?: string
}

let cached: { status: DockerStatus; checkedAt: number } | null = null
const CACHE_TTL_MS = 60_000

/**
 * Probe whether Docker is available and responsive.
 * Result is cached for 60s to avoid repeated shell calls.
 */
export function detectDocker(): DockerStatus {
  const now = Date.now()
  if (cached && now - cached.checkedAt < CACHE_TTL_MS) return cached.status

  try {
    const result = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (result.error || result.status !== 0) {
      const status: DockerStatus = { available: false }
      cached = { status, checkedAt: now }
      return status
    }
    const version = (result.stdout || '').trim() || undefined
    const status: DockerStatus = { available: true, version }
    cached = { status, checkedAt: now }
    return status
  } catch {
    const status: DockerStatus = { available: false }
    cached = { status, checkedAt: now }
    return status
  }
}

/** Clear the cached Docker probe (useful for tests). */
export function clearDockerDetectCache(): void {
  cached = null
}
