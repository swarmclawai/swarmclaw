import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runMcpConformanceCheck } from './mcp-conformance'

test('runMcpConformanceCheck reports connect/list failure for unsupported transport', async () => {
  const result = await runMcpConformanceCheck({
    id: 'bad',
    name: 'Bad MCP',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transport: 'invalid-transport' as any,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })

  assert.equal(result.ok, false)
  assert.equal(result.toolsCount, 0)
  assert.ok(result.issues.some((issue) => issue.code === 'connect_or_list_failed'))
})
