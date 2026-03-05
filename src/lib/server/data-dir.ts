import path from 'path'
import os from 'os'
import fs from 'fs'

export const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data')

// Workspace lives outside the project directory to avoid triggering Next.js HMR
// when agents create/modify files. Falls back to data/workspace for Docker/CI.
function resolveWorkspaceDir(): string {
  if (process.env.WORKSPACE_DIR) return process.env.WORKSPACE_DIR
  const external = path.join(os.homedir(), '.swarmclaw', 'workspace')
  try {
    fs.mkdirSync(external, { recursive: true })
    return external
  } catch {
    // If we can't create the external dir (permissions, etc.), fall back to in-project
    return path.join(DATA_DIR, 'workspace')
  }
}

export const WORKSPACE_DIR = resolveWorkspaceDir()
