import { execFile } from 'child_process'
import { promisify } from 'util'
import * as path from 'path'
import * as os from 'os'
import { loadSettings } from '../storage'

const execFileAsync = promisify(execFile)

export interface DoctorResult {
  ok: boolean
  output: string
  fixed: boolean
}

function resolveWorkspacePath(override?: string): string {
  if (override) return override
  const settings = loadSettings()
  if (typeof settings.openclawWorkspacePath === 'string' && settings.openclawWorkspacePath.trim()) {
    return settings.openclawWorkspacePath.trim()
  }
  return path.join(os.homedir(), '.openclaw', 'workspace')
}

export async function runOpenClawDoctor(opts?: { fix?: boolean; workspace?: string }): Promise<DoctorResult> {
  const workspace = resolveWorkspacePath(opts?.workspace)
  const args = ['doctor']
  if (opts?.fix) args.push('--fix')

  try {
    const { stdout, stderr } = await execFileAsync('openclaw', args, {
      cwd: workspace,
      timeout: 30_000,
      maxBuffer: 256 * 1024,
    })
    return {
      ok: true,
      output: (stdout + stderr).trim(),
      fixed: !!opts?.fix,
    }
  } catch (err: unknown) {
    const execErr = err as { code?: number; stdout?: string; stderr?: string; message?: string }
    return {
      ok: false,
      output: ((execErr.stdout || '') + (execErr.stderr || '') || execErr.message || String(err)).trim(),
      fixed: false,
    }
  }
}
