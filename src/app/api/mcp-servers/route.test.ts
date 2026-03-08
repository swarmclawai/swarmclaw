import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { afterEach } from 'node:test'

import { GET as getMcpServer, PUT as updateMcpServer, DELETE as deleteMcpServer } from './[id]/route'
import { POST as runMcpConformance } from './[id]/conformance/route'
import { POST as invokeMcpTool } from './[id]/invoke/route'
import { POST as testMcpServer } from './[id]/test/route'
import { GET as listMcpTools } from './[id]/tools/route'
import { GET as listMcpServers, POST as createMcpServer } from './route'
import { loadMcpServers, saveMcpServers } from '@/lib/server/storage'

const originalMcpServers = loadMcpServers()
const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../lib/server/__fixtures__/fake-mcp-stdio-server.mjs',
)

function routeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

afterEach(() => {
  saveMcpServers(originalMcpServers)
})

test('MCP server routes exercise a live stdio server end to end', async () => {
  const createResponse = await createMcpServer(new Request('http://local/api/mcp-servers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'smoke',
      transport: 'stdio',
      command: process.execPath,
      args: [fixturePath],
    }),
  }))
  assert.equal(createResponse.status, 200)
  const created = await createResponse.json() as Record<string, unknown>
  const serverId = String(created.id)
  assert.equal(created.name, 'smoke')

  const listResponse = await listMcpServers(new Request('http://local/api/mcp-servers'))
  assert.equal(listResponse.status, 200)
  const listed = await listResponse.json() as Record<string, Record<string, unknown>>
  assert.equal(listed[serverId]?.name, 'smoke')

  const detailResponse = await getMcpServer(new Request(`http://local/api/mcp-servers/${serverId}`), routeParams(serverId))
  assert.equal(detailResponse.status, 200)
  const detail = await detailResponse.json() as Record<string, unknown>
  assert.equal(detail.command, process.execPath)

  const healthResponse = await testMcpServer(new Request(`http://local/api/mcp-servers/${serverId}/test`, {
    method: 'POST',
  }), routeParams(serverId))
  assert.equal(healthResponse.status, 200)
  const health = await healthResponse.json() as Record<string, unknown>
  assert.equal(health.ok, true)
  assert.deepEqual(health.tools, ['mcp_smoke_ping', 'mcp_smoke_echo'])

  const toolsResponse = await listMcpTools(new Request(`http://local/api/mcp-servers/${serverId}/tools`), routeParams(serverId))
  assert.equal(toolsResponse.status, 200)
  const tools = await toolsResponse.json() as Array<Record<string, unknown>>
  assert.deepEqual(tools.map((tool) => tool.name), ['ping', 'echo'])

  const invokeResponse = await invokeMcpTool(new Request(`http://local/api/mcp-servers/${serverId}/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      toolName: 'echo',
      args: JSON.stringify({ message: 'hello from route test' }),
    }),
  }), routeParams(serverId))
  assert.equal(invokeResponse.status, 200)
  const invokePayload = await invokeResponse.json() as Record<string, unknown>
  assert.equal(invokePayload.ok, true)
  assert.equal(invokePayload.text, 'echo: hello from route test')

  const conformanceResponse = await runMcpConformance(new Request(`http://local/api/mcp-servers/${serverId}/conformance`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ smokeToolName: 'ping' }),
  }), routeParams(serverId))
  assert.equal(conformanceResponse.status, 200)
  const conformance = await conformanceResponse.json() as Record<string, unknown>
  assert.equal(conformance.ok, true)
  assert.equal(conformance.toolsCount, 2)
  assert.equal(conformance.smokeToolName, 'ping')

  const updateResponse = await updateMcpServer(new Request(`http://local/api/mcp-servers/${serverId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'smoke-renamed' }),
  }), routeParams(serverId))
  assert.equal(updateResponse.status, 200)
  const updated = await updateResponse.json() as Record<string, unknown>
  assert.equal(updated.name, 'smoke-renamed')

  const deleteResponse = await deleteMcpServer(new Request(`http://local/api/mcp-servers/${serverId}`, {
    method: 'DELETE',
  }), routeParams(serverId))
  assert.equal(deleteResponse.status, 200)
  assert.equal(loadMcpServers()[serverId], undefined)
})

test('MCP invoke route validates required fields before connecting', async () => {
  const serverId = 'mcp-validate-smoke'
  const servers = loadMcpServers()
  servers[serverId] = {
    id: serverId,
    name: 'smoke',
    transport: 'stdio',
    command: process.execPath,
    args: [fixturePath],
    createdAt: 1,
    updatedAt: 1,
  }
  saveMcpServers(servers)

  const response = await invokeMcpTool(new Request(`http://local/api/mcp-servers/${serverId}/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args: {} }),
  }), routeParams(serverId))

  assert.equal(response.status, 400)
  const payload = await response.json() as Record<string, unknown>
  assert.equal(payload.error, 'toolName is required')
})
