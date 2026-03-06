import path from 'path'
import os from 'os'
import fs from 'fs'

export const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data')

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
  const external = path.join(os.homedir(), '.swarmclaw', 'workspace')
  if (supportsChildWrites(external)) {
    return external
  }
  return path.join(DATA_DIR, 'workspace')
}

export const WORKSPACE_DIR = resolveWorkspaceDir()

function resolveBrowserProfilesDir(): string {
  if (process.env.BROWSER_PROFILES_DIR) return process.env.BROWSER_PROFILES_DIR
  const external = path.join(os.homedir(), '.swarmclaw', 'browser-profiles')
  if (supportsChildWrites(external)) {
    return external
  }
  return path.join(DATA_DIR, 'browser-profiles')
}

export const BROWSER_PROFILES_DIR = resolveBrowserProfilesDir()
