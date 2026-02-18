import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import fs from 'fs'
import path from 'path'
import { execSync, execFile, spawn, type ChildProcess } from 'child_process'

const MAX_OUTPUT = 50 * 1024 // 50KB
const MAX_FILE = 100 * 1024 // 100KB
const CMD_TIMEOUT = 30_000
const CLAUDE_TIMEOUT = 120_000

function safePath(cwd: string, filePath: string): string {
  const resolved = path.resolve(cwd, filePath)
  if (!resolved.startsWith(path.resolve(cwd))) {
    throw new Error('Path traversal not allowed')
  }
  return resolved
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n... [truncated at ${max} bytes]`
}

function listDirRecursive(dir: string, depth: number, maxDepth: number): string[] {
  if (depth > maxDepth) return []
  const entries: string[] = []
  try {
    const items = fs.readdirSync(dir, { withFileTypes: true })
    for (const item of items) {
      if (item.name.startsWith('.') || item.name === 'node_modules') continue
      const rel = depth === 0 ? item.name : item.name
      if (item.isDirectory()) {
        entries.push(rel + '/')
        const sub = listDirRecursive(path.join(dir, item.name), depth + 1, maxDepth)
        entries.push(...sub.map((s) => `  ${rel}/${s}`))
      } else {
        entries.push(rel)
      }
    }
  } catch {
    // permission error etc
  }
  return entries
}

export function buildSessionTools(cwd: string, enabledTools: string[]): StructuredToolInterface[] {
  const tools: StructuredToolInterface[] = []

  if (enabledTools.includes('shell')) {
    tools.push(
      tool(
        async ({ command }) => {
          try {
            const output = execSync(command, {
              cwd,
              timeout: CMD_TIMEOUT,
              maxBuffer: MAX_OUTPUT * 2,
              encoding: 'utf-8',
              stdio: ['pipe', 'pipe', 'pipe'],
            })
            return truncate(output || '(no output)', MAX_OUTPUT)
          } catch (err: any) {
            const stderr = err.stderr ? String(err.stderr) : ''
            const stdout = err.stdout ? String(err.stdout) : ''
            return truncate(`Exit code: ${err.status || 1}\n${stderr || stdout || err.message}`, MAX_OUTPUT)
          }
        },
        {
          name: 'execute_command',
          description: 'Execute a shell command in the session working directory. Returns stdout/stderr.',
          schema: z.object({
            command: z.string().describe('The shell command to execute'),
          }),
        },
      ),
    )
  }

  if (enabledTools.includes('files')) {
    tools.push(
      tool(
        async ({ filePath }) => {
          try {
            const resolved = safePath(cwd, filePath)
            const content = fs.readFileSync(resolved, 'utf-8')
            return truncate(content, MAX_FILE)
          } catch (err: any) {
            return `Error reading file: ${err.message}`
          }
        },
        {
          name: 'read_file',
          description: 'Read a file from the session working directory.',
          schema: z.object({
            filePath: z.string().describe('Relative path to the file'),
          }),
        },
      ),
    )

    tools.push(
      tool(
        async ({ filePath, content }) => {
          try {
            const resolved = safePath(cwd, filePath)
            fs.mkdirSync(path.dirname(resolved), { recursive: true })
            fs.writeFileSync(resolved, content, 'utf-8')
            return `File written: ${filePath} (${content.length} bytes)`
          } catch (err: any) {
            return `Error writing file: ${err.message}`
          }
        },
        {
          name: 'write_file',
          description: 'Write content to a file in the session working directory. Creates directories if needed.',
          schema: z.object({
            filePath: z.string().describe('Relative path to the file'),
            content: z.string().describe('The content to write'),
          }),
        },
      ),
    )

    tools.push(
      tool(
        async ({ dirPath }) => {
          try {
            const resolved = safePath(cwd, dirPath || '.')
            const tree = listDirRecursive(resolved, 0, 3)
            return tree.length ? tree.join('\n') : '(empty directory)'
          } catch (err: any) {
            return `Error listing files: ${err.message}`
          }
        },
        {
          name: 'list_files',
          description: 'List files in the session working directory recursively (max depth 3).',
          schema: z.object({
            dirPath: z.string().optional().describe('Relative path to list (defaults to working directory)'),
          }),
        },
      ),
    )
  }

  if (enabledTools.includes('claude_code')) {
    tools.push(
      tool(
        async ({ task }) => {
          try {
            return new Promise<string>((resolve) => {
              const child = execFile(
                'claude',
                ['-p', task, '--output-format', 'text'],
                { cwd, timeout: CLAUDE_TIMEOUT, maxBuffer: MAX_OUTPUT * 2 },
                (err, stdout, stderr) => {
                  if (err && !stdout) {
                    resolve(truncate(`Error: ${stderr || err.message}`, MAX_OUTPUT))
                  } else {
                    resolve(truncate(stdout || stderr || '(no output)', MAX_OUTPUT))
                  }
                },
              )
              // Kill on timeout safety net
              setTimeout(() => {
                try { child.kill('SIGTERM') } catch { /* ignore */ }
              }, CLAUDE_TIMEOUT + 5000)
            })
          } catch (err: any) {
            return `Error delegating to Claude Code: ${err.message}`
          }
        },
        {
          name: 'delegate_to_claude_code',
          description: 'Delegate a complex task to Claude Code CLI. Use for tasks that need deep code understanding, multi-file refactoring, or running tests. The task runs in the session working directory.',
          schema: z.object({
            task: z.string().describe('Detailed description of the task for Claude Code'),
          }),
        },
      ),
    )
  }

  if (enabledTools.includes('browser')) {
    // Lightweight MCP client wrapper for Playwright browser
    let mcpProcess: ChildProcess | null = null
    let mcpReqId = 1
    let pendingCallbacks = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>()
    let initialized = false
    let mcpBuf = ''

    const ensureMcp = (): Promise<void> => {
      if (initialized && mcpProcess && !mcpProcess.killed) return Promise.resolve()
      return new Promise((resolve, reject) => {
        try {
          mcpProcess = spawn('npx', ['@playwright/mcp@latest'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd,
          })

          mcpProcess.stdout!.on('data', (chunk: Buffer) => {
            mcpBuf += chunk.toString()
            // MCP uses content-length framing
            while (true) {
              const headerEnd = mcpBuf.indexOf('\r\n\r\n')
              if (headerEnd === -1) break
              const header = mcpBuf.slice(0, headerEnd)
              const lengthMatch = header.match(/Content-Length:\s*(\d+)/i)
              if (!lengthMatch) { mcpBuf = mcpBuf.slice(headerEnd + 4); continue }
              const contentLength = parseInt(lengthMatch[1])
              const bodyStart = headerEnd + 4
              if (mcpBuf.length < bodyStart + contentLength) break
              const body = mcpBuf.slice(bodyStart, bodyStart + contentLength)
              mcpBuf = mcpBuf.slice(bodyStart + contentLength)
              try {
                const msg = JSON.parse(body)
                if (msg.id !== undefined && pendingCallbacks.has(msg.id)) {
                  const cb = pendingCallbacks.get(msg.id)!
                  pendingCallbacks.delete(msg.id)
                  if (msg.error) cb.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
                  else cb.resolve(msg.result)
                }
              } catch { /* ignore parse errors */ }
            }
          })

          mcpProcess.on('error', (err) => {
            console.error('[mcp-browser] Process error:', err.message)
            initialized = false
          })

          mcpProcess.on('close', () => {
            initialized = false
            mcpProcess = null
          })

          // Send initialize
          const initId = mcpReqId++
          const initMsg = JSON.stringify({ jsonrpc: '2.0', id: initId, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'swarmclaw', version: '1.0' } } })
          const initFrame = `Content-Length: ${Buffer.byteLength(initMsg)}\r\n\r\n${initMsg}`
          mcpProcess.stdin!.write(initFrame)

          pendingCallbacks.set(initId, {
            resolve: () => {
              // Send initialized notification
              const notifMsg = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
              const notifFrame = `Content-Length: ${Buffer.byteLength(notifMsg)}\r\n\r\n${notifMsg}`
              mcpProcess!.stdin!.write(notifFrame)
              initialized = true
              resolve()
            },
            reject,
          })

          // Timeout
          setTimeout(() => {
            if (!initialized) reject(new Error('MCP browser init timeout'))
          }, 15000)
        } catch (err: any) {
          reject(err)
        }
      })
    }

    const callMcpTool = async (toolName: string, args: Record<string, any>): Promise<string> => {
      await ensureMcp()
      if (!mcpProcess || mcpProcess.killed) throw new Error('MCP browser process not running')
      return new Promise((resolve, reject) => {
        const id = mcpReqId++
        const msg = JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: toolName, arguments: args } })
        const frame = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`
        pendingCallbacks.set(id, {
          resolve: (result: any) => {
            const content = result?.content
            if (Array.isArray(content)) {
              resolve(content.map((c: any) => c.text || c.data || '').join('\n'))
            } else {
              resolve(JSON.stringify(result))
            }
          },
          reject,
        })
        mcpProcess!.stdin!.write(frame)
        setTimeout(() => {
          if (pendingCallbacks.has(id)) {
            pendingCallbacks.delete(id)
            reject(new Error(`MCP tool call timeout: ${toolName}`))
          }
        }, 30000)
      })
    }

    tools.push(
      tool(
        async ({ url }) => {
          try {
            return await callMcpTool('browser_navigate', { url })
          } catch (err: any) {
            return `Error: ${err.message}`
          }
        },
        {
          name: 'browser_navigate',
          description: 'Navigate the browser to a URL.',
          schema: z.object({ url: z.string().describe('The URL to navigate to') }),
        },
      ),
    )

    tools.push(
      tool(
        async () => {
          try {
            return await callMcpTool('browser_screenshot', {})
          } catch (err: any) {
            return `Error: ${err.message}`
          }
        },
        {
          name: 'browser_screenshot',
          description: 'Take a screenshot of the current page. Returns base64-encoded image data.',
          schema: z.object({}),
        },
      ),
    )

    tools.push(
      tool(
        async ({ element, ref }) => {
          try {
            return await callMcpTool('browser_click', { element, ref })
          } catch (err: any) {
            return `Error: ${err.message}`
          }
        },
        {
          name: 'browser_click',
          description: 'Click on an element in the browser. Provide either a CSS selector or a ref from a previous snapshot.',
          schema: z.object({
            element: z.string().optional().describe('CSS selector or description of the element to click'),
            ref: z.string().optional().describe('Element reference from a previous snapshot'),
          }),
        },
      ),
    )

    tools.push(
      tool(
        async ({ element, ref, text }) => {
          try {
            return await callMcpTool('browser_type', { element, ref, text })
          } catch (err: any) {
            return `Error: ${err.message}`
          }
        },
        {
          name: 'browser_type',
          description: 'Type text into an input element in the browser.',
          schema: z.object({
            element: z.string().optional().describe('CSS selector or description of the input'),
            ref: z.string().optional().describe('Element reference from a previous snapshot'),
            text: z.string().describe('Text to type'),
          }),
        },
      ),
    )

    tools.push(
      tool(
        async () => {
          try {
            return await callMcpTool('browser_snapshot', {})
          } catch (err: any) {
            return `Error: ${err.message}`
          }
        },
        {
          name: 'browser_get_text',
          description: 'Get an accessibility snapshot of the current page, including all visible text and interactive elements.',
          schema: z.object({}),
        },
      ),
    )
  }

  return tools
}
