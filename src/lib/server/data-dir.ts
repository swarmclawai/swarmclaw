import path from 'path'
import os from 'os'
import fs from 'fs'

function isBuildBootstrapEnv(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): boolean {
  if (env.SWARMCLAW_BUILD_MODE === '1') return true
  if (env.NEXT_PHASE === 'phase-production-build') return true
  const lifecycle = env.npm_lifecycle_event?.trim().toLowerCase()
  if (lifecycle === 'build' || lifecycle === 'build:ci' || lifecycle?.startsWith('build:')) return true
  return argv.some((arg) => /\bnext(?:[\\/](?:dist[\\/]bin[\\/])?next)?\b/.test(arg))
    && argv.some((arg) => /\bbuild\b/.test(arg))
}

export const IS_BUILD_BOOTSTRAP = isBuildBootstrapEnv()

function resolveDataDir(): string {
  if (process.env.DATA_DIR) return process.env.DATA_DIR
  if (IS_BUILD_BOOTSTRAP) return path.join(os.tmpdir(), 'swarmclaw-build-data')
  return path.join(process.cwd(), 'data')
}

export const DATA_DIR = resolveDataDir()

function supportsChildWrites(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probeDir = fs.mkdtempSync(path.join(dir, '.swarmclaw-probe-'))
    fs.rmSync(probeDir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

// Workspace lives outside the project directory to avoid triggering Next.js HMR
// when agents create/modify files. Falls back to data/workspace for Docker/CI.
function resolveWorkspaceDir(): string {
  if (process.env.WORKSPACE_DIR) return process.env.WORKSPACE_DIR
  if (IS_BUILD_BOOTSTRAP) return path.join(DATA_DIR, 'workspace')
  const external = path.join(os.homedir(), '.swarmclaw', 'workspace')
  if (supportsChildWrites(external)) {
    return external
  }
  return path.join(DATA_DIR, 'workspace')
}

export const WORKSPACE_DIR = resolveWorkspaceDir()

function resolveBrowserProfilesDir(): string {
  if (process.env.BROWSER_PROFILES_DIR) return process.env.BROWSER_PROFILES_DIR
  if (IS_BUILD_BOOTSTRAP) return path.join(DATA_DIR, 'browser-profiles')
  const external = path.join(os.homedir(), '.swarmclaw', 'browser-profiles')
  if (supportsChildWrites(external)) {
    return external
  }
  return path.join(DATA_DIR, 'browser-profiles')
}

export const BROWSER_PROFILES_DIR = resolveBrowserProfilesDir()
