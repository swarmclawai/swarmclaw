import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { execSync, execFile, spawn, type ChildProcess } from 'child_process'
import * as cheerio from 'cheerio'
import { getMemoryDb } from './memory-db'
import {
  loadAgents, saveAgents,
  loadTasks, saveTasks,
  loadSchedules, saveSchedules,
  loadSkills, saveSkills,
  loadConnectors, saveConnectors,
  loadSessions,
} from './storage'

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

interface ToolContext {
  agentId?: string | null
  sessionId?: string | null
  platformAssignScope?: 'self' | 'all'
}

export function buildSessionTools(cwd: string, enabledTools: string[], ctx?: ToolContext): StructuredToolInterface[] {
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

  if (enabledTools.includes('edit_file')) {
    tools.push(
      tool(
        async ({ filePath, oldText, newText }) => {
          try {
            const resolved = safePath(cwd, filePath)
            if (!fs.existsSync(resolved)) return `Error: File not found: ${filePath}`
            const content = fs.readFileSync(resolved, 'utf-8')
            const count = content.split(oldText).length - 1
            if (count === 0) return `Error: oldText not found in ${filePath}`
            if (count > 1) return `Error: oldText found ${count} times in ${filePath}. Make it more specific.`
            const updated = content.replace(oldText, newText)
            fs.writeFileSync(resolved, updated, 'utf-8')
            return `Successfully edited ${filePath}`
          } catch (err: any) {
            return `Error editing file: ${err.message}`
          }
        },
        {
          name: 'edit_file',
          description: 'Search and replace text in a file. The oldText must match exactly once in the file.',
          schema: z.object({
            filePath: z.string().describe('Relative path to the file'),
            oldText: z.string().describe('Exact text to find (must be unique in the file)'),
            newText: z.string().describe('Text to replace it with'),
          }),
        },
      ),
    )
  }

  if (enabledTools.includes('web_search')) {
    tools.push(
      tool(
        async ({ query, maxResults }) => {
          try {
            const limit = Math.min(maxResults || 5, 10)
            const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
            const res = await fetch(url, {
              headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SwarmClaw/1.0)' },
            })
            const html = await res.text()
            // Parse results from DuckDuckGo HTML
            const results: { title: string; url: string; snippet: string }[] = []
            const resultRegex = /<a[^>]+class="result__a"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
            let match
            while ((match = resultRegex.exec(html)) !== null && results.length < limit) {
              const rawUrl = match[1]
              const title = match[2].replace(/<[^>]+>/g, '').trim()
              const snippet = match[3].replace(/<[^>]+>/g, '').trim()
              // DuckDuckGo wraps URLs in a redirect
              const decoded = decodeURIComponent(rawUrl.replace(/.*uddg=/, '').replace(/&.*/, ''))
              results.push({ title, url: decoded || rawUrl, snippet })
            }
            if (results.length === 0) {
              // Fallback: try simpler regex
              const linkRegex = /<a[^>]+class="result__a"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g
              while ((match = linkRegex.exec(html)) !== null && results.length < limit) {
                const rawUrl = match[1]
                const title = match[2].replace(/<[^>]+>/g, '').trim()
                const decoded = decodeURIComponent(rawUrl.replace(/.*uddg=/, '').replace(/&.*/, ''))
                results.push({ title, url: decoded || rawUrl, snippet: '' })
              }
            }
            return results.length > 0
              ? JSON.stringify(results, null, 2)
              : 'No results found.'
          } catch (err: any) {
            return `Error searching web: ${err.message}`
          }
        },
        {
          name: 'web_search',
          description: 'Search the web using DuckDuckGo. Returns an array of results with title, url, and snippet.',
          schema: z.object({
            query: z.string().describe('Search query'),
            maxResults: z.number().optional().describe('Maximum results to return (default 5, max 10)'),
          }),
        },
      ),
    )
  }

  if (enabledTools.includes('web_fetch')) {
    tools.push(
      tool(
        async ({ url }) => {
          try {
            const res = await fetch(url, {
              headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SwarmClaw/1.0)' },
              signal: AbortSignal.timeout(15000),
            })
            if (!res.ok) return `HTTP ${res.status}: ${res.statusText}`
            const html = await res.text()
            // Use cheerio for robust HTML text extraction
            const $ = cheerio.load(html)
            $('script, style, noscript, nav, footer, header').remove()
            // Prefer article/main content if available
            const main = $('article, main, [role="main"]').first()
            let text = (main.length ? main.text() : $('body').text())
              .replace(/\s+/g, ' ')
              .trim()
            return truncate(text, MAX_OUTPUT)
          } catch (err: any) {
            return `Error fetching URL: ${err.message}`
          }
        },
        {
          name: 'web_fetch',
          description: 'Fetch a URL and return its text content (HTML stripped). Useful for reading web pages.',
          schema: z.object({
            url: z.string().describe('The URL to fetch'),
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

  if (enabledTools.includes('memory')) {
    const memDb = getMemoryDb()

    tools.push(
      tool(
        async ({ action, key, value, category, query }) => {
          try {
            if (action === 'store') {
              const entry = memDb.add({
                agentId: ctx?.agentId || null,
                sessionId: ctx?.sessionId || null,
                category: category || 'note',
                title: key,
                content: value || '',
              })
              return `Stored memory "${key}" (id: ${entry.id})`
            }
            if (action === 'search') {
              const results = memDb.search(query || key, ctx?.agentId || undefined)
              if (!results.length) return 'No memories found.'
              return results.map((m) => `[${m.id}] ${m.title}: ${m.content}`).join('\n')
            }
            if (action === 'list') {
              const results = memDb.list(ctx?.agentId || undefined)
              if (!results.length) return 'No memories stored yet.'
              return results.map((m) => `[${m.id}] ${m.category}/${m.title}: ${m.content}`).join('\n')
            }
            if (action === 'delete') {
              memDb.delete(key)
              return `Deleted memory "${key}"`
            }
            return `Unknown action "${action}". Use: store, search, list, or delete.`
          } catch (err: any) {
            return `Error: ${err.message}`
          }
        },
        {
          name: 'memory_tool',
          description: 'Store and retrieve long-term memories that persist across sessions. Use "store" to save knowledge, "search" to find relevant memories, "list" to see all memories, or "delete" to remove one.',
          schema: z.object({
            action: z.enum(['store', 'search', 'list', 'delete']).describe('The action to perform'),
            key: z.string().describe('For store: the memory title. For search: search query. For delete: the memory ID.'),
            value: z.string().optional().describe('The memory content (for store action)'),
            category: z.string().optional().describe('Category like "note", "fact", "preference" (for store action, defaults to "note")'),
            query: z.string().optional().describe('Search query (alternative to key for search action)'),
          }),
        },
      ),
    )
  }

  // Platform management tools — each resource type is a separate toggleable tool
  const RESOURCE_DEFAULTS: Record<string, (parsed: any) => any> = {
    manage_agents: (p) => ({
      name: p.name || 'Unnamed Agent',
      description: p.description || '',
      systemPrompt: p.systemPrompt || '',
      soul: p.soul || '',
      provider: p.provider || 'claude-cli',
      model: p.model || '',
      isOrchestrator: p.isOrchestrator || false,
      tools: p.tools || [],
      skills: p.skills || [],
      skillIds: p.skillIds || [],
      subAgentIds: p.subAgentIds || [],
      ...p,
    }),
    manage_tasks: (p) => ({
      title: p.title || 'Untitled Task',
      description: p.description || '',
      status: p.status || 'backlog',
      agentId: p.agentId || null,
      sessionId: p.sessionId || null,
      result: null,
      error: null,
      queuedAt: null,
      startedAt: null,
      completedAt: null,
      ...p,
    }),
    manage_schedules: (p) => {
      const now = Date.now()
      const base = {
        name: p.name || 'Unnamed Schedule',
        agentId: p.agentId || null,
        taskPrompt: p.taskPrompt || '',
        scheduleType: p.scheduleType || 'interval',
        status: p.status || 'active',
        ...p,
      }
      if (!base.nextRunAt) {
        if (base.scheduleType === 'once' && base.runAt) base.nextRunAt = base.runAt
        else if (base.scheduleType === 'interval' && base.intervalMs) base.nextRunAt = now + base.intervalMs
      }
      return base
    },
    manage_skills: (p) => ({
      name: p.name || 'Unnamed Skill',
      description: p.description || '',
      content: p.content || '',
      filename: p.filename || '',
      ...p,
    }),
    manage_connectors: (p) => ({
      name: p.name || 'Unnamed Connector',
      platform: p.platform || 'discord',
      agentId: p.agentId || null,
      enabled: p.enabled ?? false,
      ...p,
    }),
  }

  const PLATFORM_RESOURCES: Record<string, {
    toolId: string
    label: string
    load: () => Record<string, any>
    save: (d: Record<string, any>) => void
    readOnly?: boolean
  }> = {
    manage_agents: { toolId: 'manage_agents', label: 'agents', load: loadAgents, save: saveAgents },
    manage_tasks: { toolId: 'manage_tasks', label: 'tasks', load: loadTasks, save: saveTasks },
    manage_schedules: { toolId: 'manage_schedules', label: 'schedules', load: loadSchedules, save: saveSchedules },
    manage_skills: { toolId: 'manage_skills', label: 'skills', load: loadSkills, save: saveSkills },
    manage_connectors: { toolId: 'manage_connectors', label: 'connectors', load: loadConnectors, save: saveConnectors },
    manage_sessions: { toolId: 'manage_sessions', label: 'sessions', load: loadSessions, save: () => {}, readOnly: true },
  }

  // Build dynamic agent summary for tools that need agent awareness
  const assignScope = ctx?.platformAssignScope || 'self'
  let agentSummary = ''
  if (enabledTools.includes('manage_tasks') || enabledTools.includes('manage_schedules')) {
    if (assignScope === 'all') {
      try {
        const agents = loadAgents()
        const agentList = Object.values(agents)
          .map((a: any) => `  - "${a.id}": ${a.name}${a.description ? ` — ${a.description}` : ''}`)
          .join('\n')
        if (agentList) agentSummary = `\n\nAvailable agents:\n${agentList}`
      } catch { /* ignore */ }
    }
  }

  for (const [toolKey, res] of Object.entries(PLATFORM_RESOURCES)) {
    if (!enabledTools.includes(toolKey)) continue

    let description = `Manage SwarmClaw ${res.label}. ${res.readOnly ? 'List and get only.' : 'List, get, create, update, or delete.'} Returns JSON.`
    if (toolKey === 'manage_tasks') {
      if (assignScope === 'self') {
        description += `\n\nSet "agentId" to assign a task to yourself ("${ctx?.agentId || 'unknown'}") or leave it null. You can only assign tasks to yourself. Valid statuses: backlog, queued, running, completed, failed.`
      } else {
        description += `\n\nSet "agentId" to assign a task to an agent (including yourself: "${ctx?.agentId || 'unknown'}"). Valid statuses: backlog, queued, running, completed, failed.` + agentSummary
      }
    } else if (toolKey === 'manage_schedules') {
      if (assignScope === 'self') {
        description += `\n\nSet "agentId" to assign a schedule to yourself ("${ctx?.agentId || 'unknown'}") or leave it null. You can only assign schedules to yourself. Schedule types: interval (set intervalMs), cron (set cron), once (set runAt). Set taskPrompt for what the agent should do.`
      } else {
        description += `\n\nSet "agentId" to assign a schedule to an agent (including yourself: "${ctx?.agentId || 'unknown'}"). Schedule types: interval (set intervalMs), cron (set cron), once (set runAt). Set taskPrompt for what the agent should do.` + agentSummary
      }
    }

    tools.push(
      tool(
        async ({ action, id, data }) => {
          try {
            if (action === 'list') {
              return JSON.stringify(Object.values(res.load()))
            }
            if (action === 'get') {
              if (!id) return 'Error: "id" is required for get action.'
              const all = res.load()
              return all[id] ? JSON.stringify(all[id]) : `Not found: ${res.label} "${id}"`
            }
            if (res.readOnly) return `Cannot ${action} ${res.label} via this tool (read-only).`
            if (action === 'create') {
              const all = res.load()
              const newId = crypto.randomBytes(4).toString('hex')
              const raw = data ? JSON.parse(data) : {}
              const defaults = RESOURCE_DEFAULTS[toolKey]
              const parsed = defaults ? defaults(raw) : raw
              // Enforce assignment scope for tasks and schedules
              if (assignScope === 'self' && (toolKey === 'manage_tasks' || toolKey === 'manage_schedules')) {
                if (parsed.agentId && parsed.agentId !== ctx?.agentId) {
                  return `Error: You can only assign ${res.label} to yourself ("${ctx?.agentId}"). To assign to other agents, ask a user to enable "Assign to Other Agents" in your agent settings.`
                }
              }
              const now = Date.now()
              const entry = {
                id: newId,
                ...parsed,
                createdByAgentId: ctx?.agentId || null,
                createdInSessionId: ctx?.sessionId || null,
                createdAt: now,
                updatedAt: now,
              }
              all[newId] = entry
              res.save(all)
              return JSON.stringify(entry)
            }
            if (action === 'update') {
              if (!id) return 'Error: "id" is required for update action.'
              const all = res.load()
              if (!all[id]) return `Not found: ${res.label} "${id}"`
              const parsed = data ? JSON.parse(data) : {}
              // Enforce assignment scope for tasks and schedules
              if (assignScope === 'self' && (toolKey === 'manage_tasks' || toolKey === 'manage_schedules')) {
                if (parsed.agentId && parsed.agentId !== ctx?.agentId) {
                  return `Error: You can only assign ${res.label} to yourself ("${ctx?.agentId}"). To assign to other agents, ask a user to enable "Assign to Other Agents" in your agent settings.`
                }
              }
              all[id] = { ...all[id], ...parsed, updatedAt: Date.now() }
              res.save(all)
              return JSON.stringify(all[id])
            }
            if (action === 'delete') {
              if (!id) return 'Error: "id" is required for delete action.'
              const all = res.load()
              if (!all[id]) return `Not found: ${res.label} "${id}"`
              delete all[id]
              res.save(all)
              return JSON.stringify({ deleted: id })
            }
            return `Unknown action "${action}". Valid: list, get, create, update, delete`
          } catch (err: any) {
            return `Error: ${err.message}`
          }
        },
        {
          name: toolKey,
          description,
          schema: z.object({
            action: z.enum(['list', 'get', 'create', 'update', 'delete']).describe('The CRUD action to perform'),
            id: z.string().optional().describe('Resource ID (required for get, update, delete)'),
            data: z.string().optional().describe('JSON string of fields for create/update'),
          }),
        },
      ),
    )
  }

  return tools
}
