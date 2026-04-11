import { spawn, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id?: number | string | null
  result?: unknown
  error?: {
    code?: number
    message?: string
    data?: unknown
  }
  method?: string
  params?: unknown
}

export interface AcpClientOptions {
  command: string
  args?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

export class AcpClient extends EventEmitter {
  private readonly proc: ChildProcess
  private readonly timeoutMs: number
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  private nextId = 1
  private stdoutBuf = ''

  constructor(options: AcpClientOptions) {
    super()
    this.timeoutMs = Math.max(1_000, options.timeoutMs || 30_000)
    this.proc = spawn(options.command, options.args || [], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.proc.stdout?.on('data', (chunk: Buffer) => this.handleStdout(chunk.toString()))
    this.proc.stderr?.on('data', (chunk: Buffer) => {
      this.emit('stderr', chunk.toString())
    })
    this.proc.on('error', (err) => this.failPending(err))
    this.proc.on('close', () => this.failPending(new Error('ACP process closed')))
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++
    const payload: JsonRpcRequest = { jsonrpc: '2.0', id, method }
    if (params !== undefined) payload.params = params

    const response = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`ACP request timed out: ${method}`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.proc.stdin?.write(`${JSON.stringify(payload)}\n`)
    })

    return response
  }

  notify(method: string, params?: unknown): void {
    const payload = params === undefined
      ? { jsonrpc: '2.0', method }
      : { jsonrpc: '2.0', method, params }
    this.proc.stdin?.write(`${JSON.stringify(payload)}\n`)
  }

  close(): void {
    this.failPending(new Error('ACP client closed'))
    try { this.proc.kill('SIGTERM') } catch { /* ignore */ }
  }

  private handleStdout(raw: string): void {
    this.stdoutBuf += raw
    const lines = this.stdoutBuf.split('\n')
    this.stdoutBuf = lines.pop() || ''

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const message = JSON.parse(line) as JsonRpcResponse
        if (typeof message.id === 'number' && this.pending.has(message.id)) {
          const entry = this.pending.get(message.id)!
          clearTimeout(entry.timer)
          this.pending.delete(message.id)
          if (message.error?.message) entry.reject(new Error(message.error.message))
          else entry.resolve(message.result)
          continue
        }
        this.emit('notification', message)
      } catch {
        this.emit('raw', line)
      }
    }
  }

  private failPending(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(err)
    }
    this.pending.clear()
  }
}
