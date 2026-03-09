import { execSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import { errorMessage } from '@/lib/shared-utils'

/**
 * OpenClaw Guardian — Auto-Rollback capability.
 * If an agent fails a task critically and has autoRecovery enabled,
 * we attempt to roll back the workspace to the last known good state.
 */
export function performGuardianRollback(cwd: string): { ok: boolean; reason?: string } {
  try {
    const gitDir = path.join(cwd, '.git')
    if (!fs.existsSync(gitDir)) {
      return { ok: false, reason: 'Workspace is not a git repository. Cannot rollback.' }
    }

    // Check if dirty
    const status = execSync('git status --porcelain', { cwd, encoding: 'utf8' })
    if (!status.trim()) {
      return { ok: false, reason: 'Workspace is clean. Nothing to rollback.' }
    }

    console.log(`[guardian] Auto-recovery triggered in ${cwd}. Rolling back changes...`)
    
    // Perform rollback
    execSync('git reset --hard HEAD', { cwd, encoding: 'utf8' })
    execSync('git clean -fd', { cwd, encoding: 'utf8' })

    return { ok: true }
  } catch (err: unknown) {
    console.error('[guardian] Auto-rollback failed:', err)
    return { ok: false, reason: `Git operation failed: ${errorMessage(err)}` }
  }
}
