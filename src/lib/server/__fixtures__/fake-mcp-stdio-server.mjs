import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({
  name: 'swarmclaw-fake-mcp',
  version: '1.0.0',
})

server.registerTool('ping', {
  description: 'Returns pong for smoke tests',
  inputSchema: {},
}, async () => ({
  content: [{ type: 'text', text: 'pong' }],
}))

server.registerTool('echo', {
  description: 'Echoes a caller-provided message',
  inputSchema: {
    message: z.string(),
  },
}, async ({ message }) => ({
  content: [{ type: 'text', text: `echo: ${message}` }],
}))

const transport = new StdioServerTransport()
await server.connect(transport)
