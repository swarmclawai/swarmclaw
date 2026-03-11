import { genId } from '@/lib/id'
import { hmrSingleton, sleep } from '@/lib/shared-utils'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { detectDocker } from '@/lib/server/sandbox/docker-detect'

const MAX_LOG_CHARS = 200_000
const DEFAULT_BACKGROUND_YIELD_MS = 10_000
const DEFAULT_TIMEOUT_MS = 30 * 60_000
const DEFAULT_TTL_MS = 30 * 60_000
const BACKGROUND_STARTUP_GRACE_MS = 500

export type ProcessStatus = 'running' | 'exited' | 'killed' | 'failed' | 'timeout'

export interface ProcessRecord {
  id: string
  command: string
  cwd: string
  agentId?: string | null
  sessionId?: string | null
  sandboxMode?: 'ephemeral' | 'persistent' | null
  sandboxContainerName?: string | null
  status: ProcessStatus
  pid: number | null
  startedAt: number
  endedAt: number | null
  exitCode: number | null
  signal: string | null
  log: string
  pollCursor: number
  timeoutAt: number | null
}

export interface EphemeralSandboxOptions {
  kind?: 'ephemeral'
  image: string
  network: 'none' | 'bridge'
  memoryMb: number
  cpus: number
  readonlyRoot: boolean
  pidsLimit?: number
  env?: Record<string, string>
  workspaceMounts: Array<{ hostPath: string; containerPath: string; readonly?: boolean }>
}

export interface PersistentSandboxOptions {
  kind: 'persistent'
  containerName: string
  containerWorkdir: string
  env?: Record<string, string>
}

export type SandboxOptions = EphemeralSandboxOptions | PersistentSandboxOptions

export interface StartProcessOptions {
  command: string
  cwd: string
  env?: Record<string, string>
  agentId?: string | null
  sessionId?: string | null
  timeoutMs?: number
  yieldMs?: number
  background?: boolean
  sandbox?: SandboxOptions
}

export interface StartProcessResult {
  status: 'completed' | 'running'
  processId: string
  output?: string
  tail?: string
  exitCode?: number | null
  signal?: string | null
}

interface RuntimeState {
  records: Map<string, ProcessRecord>
  children: Map<string, ChildProcessWithoutNullStreams>
  exitWaiters: Map<string, Promise<ProcessRecord>>
}

const state: RuntimeState = hmrSingleton<RuntimeState>('__swarmclaw_process_manager__', () => ({
  records: new Map<string, ProcessRecord>(),
  children: new Map<string, ChildProcessWithoutNullStreams>(),
  exitWaiters: new Map<string, Promise<ProcessRecord>>(),
}))

function now() {
  return Date.now()
}

function trimLog(text: string): string {
  if (text.length <= MAX_LOG_CHARS) return text
  return text.slice(text.length - MAX_LOG_CHARS)
}

function appendLog(id: string, chunk: string) {
  const rec = state.records.get(id)
  if (!rec) return
  rec.log = trimLog(rec.log + chunk)
}

function getTail(text: string, n = 4000): string {
  return text.length <= n ? text : text.slice(text.length - n)
}

function markEnded(id: string, patch: Partial<ProcessRecord>) {
  const rec = state.records.get(id)
  if (!rec) return
  rec.status = (patch.status || rec.status) as ProcessStatus
  rec.endedAt = patch.endedAt ?? now()
  rec.exitCode = patch.exitCode ?? rec.exitCode
  rec.signal = patch.signal ?? rec.signal
  if (rec.sandboxMode === 'ephemeral' && rec.sandboxContainerName) {
    cleanupSandboxContainer(rec.sandboxContainerName)
  }
}

function cleanupSandboxContainer(containerName: string) {
  if (!detectDocker().available) return
  try {
    const child = spawn('docker', ['rm', '-f', containerName], { stdio: 'ignore', detached: true })
    child.on('error', () => { /* Docker may disappear between detect and cleanup */ })
    child.unref()
  } catch { /* Docker may not be present or container already removed */ }
}

function normalizeLines(text: string): string[] {
  return text.split('\n')
}

function appendDockerEnvArgs(args: string[], env?: Record<string, string>): string {
  let prependPath = ''
  for (const [key, value] of Object.entries(env || {})) {
    if (key === 'PATH') {
      if (value) args.push('-e', `SWARMCLAW_PREPEND_PATH=${value}`)
      prependPath = value
      continue
    }
    args.push('-e', `${key}=${value}`)
  }
  return prependPath
    ? 'export PATH="${SWARMCLAW_PREPEND_PATH}:$PATH"; unset SWARMCLAW_PREPEND_PATH; '
    : ''
}

export function buildDockerExecArgs(params: {
  containerName: string
  command: string
  workdir?: string
  env?: Record<string, string>
}): string[] {
  const args = ['exec', '-i']
  if (params.workdir) args.push('-w', params.workdir)
  const pathExport = appendDockerEnvArgs(args, params.env)
  args.push(params.containerName, '/bin/sh', '-lc', `${pathExport}${params.command}`)
  return args
}

export function getShellCommand(command: string, processId?: string, sandbox?: SandboxOptions): { shell: string; args: string[]; containerName?: string } {
  if (!sandbox) {
    return { shell: '/bin/zsh', args: ['-lc', command] }
  }

  if (sandbox.kind === 'persistent') {
    return {
      shell: 'docker',
      args: buildDockerExecArgs({
        containerName: sandbox.containerName,
        command,
        workdir: sandbox.containerWorkdir,
        env: sandbox.env,
      }),
      containerName: sandbox.containerName,
    }
  }

  const containerName = `swarmclaw-sb-${processId || genId(6)}`
  const dockerArgs: string[] = [
    'run', '--rm', '-i',
    `--name=${containerName}`,
    `--network=${sandbox.network}`,
    `--memory=${sandbox.memoryMb}m`,
    `--cpus=${sandbox.cpus}`,
    `--pids-limit=${sandbox.pidsLimit || 256}`,
    '--security-opt=no-new-privileges',
  ]

  if (sandbox.readonlyRoot) {
    dockerArgs.push('--read-only', '--tmpfs', '/tmp:rw,size=128m')
  }

  for (const mount of sandbox.workspaceMounts) {
    const mode = mount.readonly ? 'ro' : 'rw'
    dockerArgs.push('-v', `${mount.hostPath}:${mount.containerPath}:${mode}`)
  }

  // Default working directory to /workspace if a workspace mount exists
  const workspaceMount = sandbox.workspaceMounts.find((m) => m.containerPath === '/workspace')
  if (workspaceMount) {
    dockerArgs.push('-w', '/workspace')
  }

  const pathExport = appendDockerEnvArgs(dockerArgs, sandbox.env)
  dockerArgs.push(sandbox.image, '/bin/sh', '-lc', `${pathExport}${command}`)

  return { shell: 'docker', args: dockerArgs, containerName }
}

export async function startManagedProcess(opts: StartProcessOptions): Promise<StartProcessResult> {
  const id = genId(8)
  const timeoutMs = Math.max(1000, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const yieldMs = Math.max(250, opts.yieldMs ?? DEFAULT_BACKGROUND_YIELD_MS)
  const startedAt = now()
  const timeoutAt = startedAt + timeoutMs

  const record: ProcessRecord = {
    id,
    command: opts.command,
    cwd: opts.cwd,
    agentId: opts.agentId ?? null,
    sessionId: opts.sessionId ?? null,
    sandboxMode: opts.sandbox ? (opts.sandbox.kind === 'persistent' ? 'persistent' : 'ephemeral') : null,
    sandboxContainerName: opts.sandbox
      ? (opts.sandbox.kind === 'persistent' ? opts.sandbox.containerName : `swarmclaw-sb-${id}`)
      : null,
    status: 'running',
    pid: null,
    startedAt,
    endedAt: null,
    exitCode: null,
    signal: null,
    log: '',
    pollCursor: 0,
    timeoutAt,
  }
  state.records.set(id, record)

  const { shell, args } = getShellCommand(opts.command, id, opts.sandbox)
  const child = spawn(shell, args, {
    cwd: opts.sandbox ? undefined : opts.cwd,
    env: opts.sandbox ? process.env : { ...process.env, ...(opts.env || {}) },
    stdio: 'pipe',
  })
  state.children.set(id, child)
  record.pid = child.pid ?? null

  const timeoutTimer = setTimeout(() => {
    const rec = state.records.get(id)
    if (!rec || rec.status !== 'running') return
    rec.status = 'timeout'
    appendLog(id, '\n[process] Timeout reached. Terminating process.\n')
    try { child.kill('SIGTERM') } catch { /* noop */ }
  }, timeoutMs)

  child.stdout.on('data', (buf: Buffer) => appendLog(id, buf.toString()))
  child.stderr.on('data', (buf: Buffer) => appendLog(id, buf.toString()))

  const exitPromise = new Promise<ProcessRecord>((resolve) => {
    child.on('error', (err) => {
      clearTimeout(timeoutTimer)
      appendLog(id, `\n[process] Spawn error: ${err.message}\n`)
      markEnded(id, { status: 'failed', exitCode: 1, signal: null, endedAt: now() })
      state.children.delete(id)
      resolve(state.records.get(id)!)
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timeoutTimer)
      const rec = state.records.get(id)
      if (!rec) return
      const timedOut = rec.status === 'timeout'
      const killed = rec.status === 'killed'
      markEnded(id, {
        status: timedOut ? 'timeout' : killed ? 'killed' : 'exited',
        exitCode: typeof code === 'number' ? code : rec.exitCode,
        signal: signal ? String(signal) : rec.signal,
        endedAt: now(),
      })
      state.children.delete(id)
      resolve(state.records.get(id)!)
    })
  })
  state.exitWaiters.set(id, exitPromise)

  if (opts.background) {
    // Give background processes a brief grace window so immediate crashes
    // (e.g., bind/permission errors) are surfaced instead of misreported as running.
    const startupWaitMs = Math.min(
      Math.max(100, BACKGROUND_STARTUP_GRACE_MS),
      Math.max(200, timeoutMs),
    )
    await sleep(startupWaitMs)
    const rec = state.records.get(id)
    if (rec && rec.status !== 'running') {
      return {
        status: 'completed',
        processId: id,
        output: rec.log,
        exitCode: rec.exitCode,
        signal: rec.signal,
      }
    }
    return {
      status: 'running',
      processId: id,
      tail: getTail(record.log),
    }
  }

  const completed = await Promise.race([
    exitPromise.then((r) => ({ type: 'exit' as const, record: r })),
    sleep(yieldMs).then(() => ({ type: 'yield' as const })),
  ])

  if (completed.type === 'yield') {
    return {
      status: 'running',
      processId: id,
      tail: getTail(state.records.get(id)?.log || ''),
    }
  }

  const rec = completed.record
  return {
    status: 'completed',
    processId: id,
    output: rec.log,
    exitCode: rec.exitCode,
    signal: rec.signal,
  }
}

export function listManagedProcesses(agentId?: string | null): ProcessRecord[] {
  sweepManagedProcesses()
  const list = Array.from(state.records.values())
  return list
    .filter((r) => !agentId || r.agentId === agentId)
    .sort((a, b) => b.startedAt - a.startedAt)
}

export function getManagedProcess(processId: string): ProcessRecord | null {
  sweepManagedProcesses()
  return state.records.get(processId) || null
}

export function pollManagedProcess(processId: string): { process: ProcessRecord; chunk: string } | null {
  const rec = state.records.get(processId)
  if (!rec) return null
  const chunk = rec.log.slice(rec.pollCursor)
  rec.pollCursor = rec.log.length
  return { process: rec, chunk }
}

export function readManagedProcessLog(
  processId: string,
  offset?: number,
  limit?: number,
): { process: ProcessRecord; text: string; totalLines: number } | null {
  const rec = state.records.get(processId)
  if (!rec) return null
  const lines = normalizeLines(rec.log)
  const total = lines.length

  const safeOffset = Math.max(0, Number.isFinite(offset) ? Math.trunc(offset as number) : Math.max(0, total - 200))
  let safeLimit = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit as number)) : 200
  if (!Number.isFinite(limit) && Number.isFinite(offset)) {
    safeLimit = Math.max(1, total - safeOffset)
  }

  const slice = lines.slice(safeOffset, safeOffset + safeLimit)
  return {
    process: rec,
    text: slice.join('\n'),
    totalLines: total,
  }
}

export function writeManagedProcessStdin(processId: string, data: string, eof?: boolean): { ok: boolean; error?: string } {
  const child = state.children.get(processId)
  const rec = state.records.get(processId)
  if (!child || !rec) return { ok: false, error: 'Process not running' }
  if (rec.status !== 'running') return { ok: false, error: `Process is ${rec.status}` }
  try {
    if (data) child.stdin.write(data)
    if (eof) child.stdin.end()
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err.message || String(err) }
  }
}

export function killManagedProcess(processId: string, signal: NodeJS.Signals = 'SIGTERM'): { ok: boolean; error?: string } {
  const child = state.children.get(processId)
  const rec = state.records.get(processId)
  if (!child || !rec) return { ok: false, error: 'Process not running' }
  try {
    rec.status = 'killed'
    child.kill(signal)
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err.message || String(err) }
  }
}

export function clearManagedProcess(processId: string): { ok: boolean; error?: string } {
  const rec = state.records.get(processId)
  if (!rec) return { ok: false, error: 'Process not found' }
  if (rec.status === 'running') return { ok: false, error: 'Cannot clear a running process' }
  state.records.delete(processId)
  state.children.delete(processId)
  state.exitWaiters.delete(processId)
  return { ok: true }
}

export function removeManagedProcess(processId: string): { ok: boolean; error?: string } {
  const rec = state.records.get(processId)
  if (!rec) return { ok: false, error: 'Process not found' }
  if (rec.status === 'running') {
    const killed = killManagedProcess(processId, 'SIGTERM')
    if (!killed.ok) return killed
  }
  state.records.delete(processId)
  state.children.delete(processId)
  state.exitWaiters.delete(processId)
  return { ok: true }
}

export function sweepManagedProcesses(ttlMs = DEFAULT_TTL_MS): number {
  const threshold = now() - Math.max(60_000, ttlMs)
  let removed = 0
  for (const [id, rec] of state.records) {
    if (rec.status === 'running') continue
    if (!rec.endedAt || rec.endedAt > threshold) continue
    state.records.delete(id)
    state.children.delete(id)
    state.exitWaiters.delete(id)
    removed++
  }
  return removed
}

/** Kill running processes and clear completed records that belong to a session. */
export function cleanupSessionProcesses(sessionId: string): number {
  let cleaned = 0
  for (const [id, rec] of state.records) {
    if (rec.sessionId !== sessionId) continue
    if (rec.status === 'running') {
      const child = state.children.get(id)
      try { child?.kill('SIGTERM') } catch { /* ignore */ }
    }
    state.records.delete(id)
    state.children.delete(id)
    state.exitWaiters.delete(id)
    cleaned++
  }
  return cleaned
}
