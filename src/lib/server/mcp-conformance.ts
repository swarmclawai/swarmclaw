import type { McpServerConfig } from '@/types'
import { connectMcpServer, disconnectMcpServer } from './mcp-client'

export interface McpConformanceIssue {
  level: 'error' | 'warning'
  code: string
  message: string
  toolName?: string
}

export interface McpConformanceOptions {
  timeoutMs?: number
  smokeToolName?: string | null
  smokeToolArgs?: Record<string, unknown> | null
}

export interface McpConformanceResult {
  ok: boolean
  serverId: string
  serverName: string
  checkedAt: number
  toolsCount: number
  smokeToolName: string | null
  issues: McpConformanceIssue[]
  timings: {
    connectMs: number
    listToolsMs: number
    smokeInvokeMs: number | null
  }
}

const DEFAULT_TIMEOUT_MS = 12_000
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 120_000

function normalizeTimeoutMs(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : Number.NaN
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.trunc(parsed)))
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizedRequired(schema: Record<string, unknown>): string[] {
  const required = schema.required
  if (!Array.isArray(required)) return []
  return required.filter((entry): entry is string => typeof entry === 'string')
}

function findSmokeTool(tools: Array<Record<string, unknown>>, preferredName?: string | null): string | null {
  const preferred = typeof preferredName === 'string' ? preferredName.trim() : ''
  if (preferred) {
    const found = tools.find((tool) => tool.name === preferred)
    if (found) return preferred
  }

  const noArg = tools.find((tool) => {
    const schema = isRecord(tool.inputSchema) ? tool.inputSchema : {}
    const required = normalizedRequired(schema)
    return required.length === 0
  })
  if (noArg && typeof noArg.name === 'string' && noArg.name.trim()) return noArg.name
  return null
}

function validateToolSchemas(tools: Array<Record<string, unknown>>, issues: McpConformanceIssue[]): void {
  const seenNames = new Set<string>()
  for (const tool of tools) {
    const toolName = typeof tool.name === 'string' ? tool.name.trim() : ''
    if (!toolName) {
      issues.push({
        level: 'error',
        code: 'tool_name_missing',
        message: 'Tool is missing a valid name.',
      })
      continue
    }
    if (seenNames.has(toolName)) {
      issues.push({
        level: 'error',
        code: 'tool_name_duplicate',
        message: `Duplicate tool name "${toolName}" detected.`,
        toolName,
      })
      continue
    }
    seenNames.add(toolName)

    const schema = isRecord(tool.inputSchema) ? tool.inputSchema : null
    if (!schema) {
      issues.push({
        level: 'warning',
        code: 'tool_schema_missing',
        message: `Tool "${toolName}" is missing an input schema.`,
        toolName,
      })
      continue
    }

    const schemaType = typeof schema.type === 'string' ? schema.type : 'object'
    if (schemaType !== 'object') {
      issues.push({
        level: 'warning',
        code: 'tool_schema_non_object',
        message: `Tool "${toolName}" schema type is "${schemaType}" (expected "object").`,
        toolName,
      })
    }

    const properties = isRecord(schema.properties) ? schema.properties : {}
    const required = normalizedRequired(schema)
    for (const req of required) {
      if (!Object.prototype.hasOwnProperty.call(properties, req)) {
        issues.push({
          level: 'warning',
          code: 'tool_schema_required_missing_property',
          message: `Tool "${toolName}" marks "${req}" as required but it is not present in schema.properties.`,
          toolName,
        })
      }
    }
  }
}

export async function runMcpConformanceCheck(
  server: McpServerConfig,
  options: McpConformanceOptions = {},
): Promise<McpConformanceResult> {
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs)
  const issues: McpConformanceIssue[] = []
  const checkedAt = Date.now()
  const result: McpConformanceResult = {
    ok: false,
    serverId: server.id,
    serverName: server.name,
    checkedAt,
    toolsCount: 0,
    smokeToolName: null,
    issues,
    timings: {
      connectMs: 0,
      listToolsMs: 0,
      smokeInvokeMs: null,
    },
  }

  let client: unknown
  let transport: unknown
  const connectStart = Date.now()
  try {
    const conn = await withTimeout(connectMcpServer(server), timeoutMs, 'MCP connect')
    client = conn.client
    transport = conn.transport
    result.timings.connectMs = Date.now() - connectStart

    const mcpClient = client as { listTools: () => Promise<Record<string, unknown>>; callTool: (opts: Record<string, unknown>) => Promise<unknown> }
    const listStart = Date.now()
    const listResponse = await withTimeout(mcpClient.listTools(), timeoutMs, 'MCP listTools') as Record<string, unknown>
    result.timings.listToolsMs = Date.now() - listStart
    const tools = Array.isArray(listResponse?.tools) ? listResponse.tools as Array<Record<string, unknown>> : []
    result.toolsCount = tools.length

    validateToolSchemas(tools, issues)

    const smokeToolName = findSmokeTool(tools, options.smokeToolName)
    result.smokeToolName = smokeToolName
    if (!smokeToolName) {
      issues.push({
        level: 'warning',
        code: 'smoke_tool_missing',
        message: 'No smoke-testable tool found (no no-arg tool and no explicit smokeToolName).',
      })
    } else {
      const smokeArgs = options.smokeToolArgs && isRecord(options.smokeToolArgs)
        ? options.smokeToolArgs
        : {}
      const smokeStart = Date.now()
      try {
        await withTimeout(
          mcpClient.callTool({ name: smokeToolName, arguments: smokeArgs }),
          timeoutMs,
          `MCP callTool(${smokeToolName})`,
        )
      } catch (err) {
        issues.push({
          level: 'error',
          code: 'smoke_tool_failed',
          message: err instanceof Error ? err.message : String(err),
          toolName: smokeToolName,
        })
      } finally {
        result.timings.smokeInvokeMs = Date.now() - smokeStart
      }
    }
  } catch (err) {
    issues.push({
      level: 'error',
      code: 'connect_or_list_failed',
      message: err instanceof Error ? err.message : String(err),
    })
  } finally {
    if (client && transport) {
      await disconnectMcpServer(client, transport)
    }
  }

  result.ok = issues.every((issue) => issue.level !== 'error')
  return result
}
