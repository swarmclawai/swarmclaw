import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import type { McpServerConfig } from '@/types'

/* ---------- JSON Schema → Zod helpers ---------- */

function jsonSchemaTypeToZod(prop: any): z.ZodTypeAny {
  if (!prop || !prop.type) return z.any()
  switch (prop.type) {
    case 'string':  return z.string()
    case 'number':
    case 'integer': return z.number()
    case 'boolean': return z.boolean()
    case 'array':   return z.array(z.any())
    case 'object':  return jsonSchemaToZod(prop)
    default:        return z.any()
  }
}

function jsonSchemaToZod(schema: any): z.ZodObject<any> {
  if (!schema || schema.type !== 'object' || !schema.properties) {
    return z.object({})
  }
  const shape: Record<string, z.ZodTypeAny> = {}
  const required = new Set<string>(schema.required ?? [])
  for (const [key, prop] of Object.entries(schema.properties)) {
    const base = jsonSchemaTypeToZod(prop as any)
    shape[key] = required.has(key) ? base : base.optional()
  }
  return z.object(shape)
}

/* ---------- Sanitize server name for tool naming ---------- */

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_')
}

/* ---------- Connect to an MCP server ---------- */

export async function connectMcpServer(
  config: McpServerConfig
): Promise<{ client: any; transport: any }> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')

  let transport: any

  if (config.transport === 'stdio') {
    const { StdioClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/stdio.js'
    )
    transport = new StdioClientTransport({
      command: config.command!,
      args: config.args ?? [],
      env: { ...process.env, ...config.env } as Record<string, string>,
    })
  } else if (config.transport === 'sse') {
    const { SSEClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/sse.js'
    )
    transport = new SSEClientTransport(new URL(config.url!), {
      requestInit: config.headers
        ? { headers: config.headers }
        : undefined,
    })
  } else if (config.transport === 'streamable-http') {
    const { StreamableHTTPClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/streamableHttp.js'
    )
    transport = new StreamableHTTPClientTransport(new URL(config.url!), {
      requestInit: config.headers
        ? { headers: config.headers }
        : undefined,
    })
  } else {
    throw new Error(`Unsupported MCP transport: ${config.transport}`)
  }

  const client = new Client(
    { name: 'swarmclaw', version: '1.0' },
    { capabilities: {} }
  )
  await client.connect(transport)

  return { client, transport }
}

/* ---------- Convert MCP tools to LangChain tools ---------- */

export async function mcpToolsToLangChain(
  client: any,
  serverName: string
): Promise<StructuredToolInterface[]> {
  const { tools: mcpTools } = await client.listTools()
  const safeName = sanitizeName(serverName)

  return mcpTools.map((mcpTool: any) => {
    const schema = jsonSchemaToZod(mcpTool.inputSchema ?? { type: 'object', properties: {} })

    return tool(
      async (args: Record<string, any>) => {
        const result = await client.callTool({
          name: mcpTool.name,
          arguments: args,
        })
        const parts = (result.content ?? [])
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
        return parts.join('\n') || '(no output)'
      },
      {
        name: `mcp_${safeName}_${mcpTool.name}`,
        description: mcpTool.description ?? `MCP tool: ${mcpTool.name}`,
        schema,
      }
    )
  })
}

/* ---------- Disconnect ---------- */

export async function disconnectMcpServer(
  client: any,
  transport: any
): Promise<void> {
  try { await client.close() } catch { /* ignore */ }
  try { await transport.close() } catch { /* ignore */ }
}

export { jsonSchemaToZod, sanitizeName }  // test exports
