import crypto from 'crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'

const MAX_LOG_CHARS = 200_000
const DEFAULT_BACKGROUND_YIELD_MS = 10_000
const DEFAULT_TIMEOUT_MS = 30 * 60_000
const DEFAULT_TTL_MS = 30 * 60_000

export type ProcessStatus = 'running' | 'exited' | 'killed' | 'failed' | 'timeout'

export interface ProcessRecord {
  id: string
  command: string
  cwd: string
  agentId?: string | null
  sessionId?: string | null
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

export interface StartProcessOptions {
  command: string
  cwd: string
  env?: Record<string, string>
  agentId?: string | null
  sessionId?: string | null
  timeoutMs?: number
  yieldMs?: number
  background?: boolean
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

const globalKey = '__swarmclaw_process_manager__' as const
const state: RuntimeState = (globalThis as any)[globalKey] ?? ((globalThis as any)[globalKey] = {
  records: new Map<string, ProcessRecord>(),
  children: new Map<string, ChildProcessWithoutNullStreams>(),
  exitWaiters: new Map<string, Promise<ProcessRecord>>(),
})

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
}

function normalizeLines(text: string): string[] {
  return text.split('\n')
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function getShellCommand(command: string): { shell: string; args: string[] } {
  return { shell: '/bin/zsh', args: ['-lc', command] }
}

export async function startManagedProcess(opts: StartProcessOptions): Promise<StartProcessResult> {
  const id = crypto.randomBytes(8).toString('hex')
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

  const { shell, args } = getShellCommand(opts.command)
  const child = spawn(shell, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env || {}) },
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
    return {
      status: 'running',
      processId: id,
      tail: getTail(record.log),
    }
  }

  const completed = await Promise.race([
    exitPromise.then((r) => ({ type: 'exit' as const, record: r })),
    wait(yieldMs).then(() => ({ type: 'yield' as const })),
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
