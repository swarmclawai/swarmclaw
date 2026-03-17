import type { ChildProcess } from 'node:child_process'

import { hmrSingleton } from '@/lib/shared-utils'

export type ActiveSessionProcess = {
  runId?: string | null
  source?: string
  kill: (signal?: NodeJS.Signals | number) => boolean | void
}

export interface DevServerRuntime {
  proc: ChildProcess
  url: string
}

interface RuntimeStateRegistry {
  activeSessionProcesses: Map<string, ActiveSessionProcess>
  devServers: Map<string, DevServerRuntime>
}

const state = hmrSingleton<RuntimeStateRegistry>('__swarmclaw_runtime_state__', () => ({
  activeSessionProcesses: new Map<string, ActiveSessionProcess>(),
  devServers: new Map<string, DevServerRuntime>(),
}))

if (!state.activeSessionProcesses) state.activeSessionProcesses = new Map<string, ActiveSessionProcess>()
if (!state.devServers) state.devServers = new Map<string, DevServerRuntime>()

export const activeSessionProcesses = state.activeSessionProcesses
export const devServers = state.devServers

export function getActiveSessionProcess(sessionId: string): ActiveSessionProcess | undefined {
  return state.activeSessionProcesses.get(sessionId)
}

export function hasActiveSessionProcess(sessionId: string): boolean {
  return state.activeSessionProcesses.has(sessionId)
}

export function registerActiveSessionProcess(sessionId: string, process: ActiveSessionProcess): void {
  state.activeSessionProcesses.set(sessionId, process)
}

export function stopActiveSessionProcess(sessionId: string, signal?: NodeJS.Signals | number): boolean {
  const process = state.activeSessionProcesses.get(sessionId)
  if (!process) return false
  try {
    process.kill(signal)
  } catch {
    // Ignore process teardown errors during cleanup.
  }
  state.activeSessionProcesses.delete(sessionId)
  return true
}

export function clearActiveSessionProcess(sessionId: string): void {
  state.activeSessionProcesses.delete(sessionId)
}

export function getDevServer(sessionId: string): DevServerRuntime | undefined {
  return state.devServers.get(sessionId)
}

export function hasDevServer(sessionId: string): boolean {
  return state.devServers.has(sessionId)
}

export function registerDevServer(sessionId: string, runtime: DevServerRuntime): void {
  state.devServers.set(sessionId, runtime)
}

export function updateDevServerUrl(sessionId: string, url: string): void {
  const runtime = state.devServers.get(sessionId)
  if (!runtime) return
  runtime.url = url
}

export function stopDevServer(sessionId: string): boolean {
  const runtime = state.devServers.get(sessionId)
  if (!runtime) return false
  try {
    runtime.proc.kill('SIGTERM')
  } catch {
    // Ignore process teardown errors during cleanup.
  }
  if (typeof runtime.proc.pid === 'number') {
    try {
      process.kill(-runtime.proc.pid, 'SIGTERM')
    } catch {
      // Ignore process-group teardown errors when the child is already gone.
    }
  }
  state.devServers.delete(sessionId)
  return true
}

export function clearDevServer(sessionId: string): void {
  state.devServers.delete(sessionId)
}
