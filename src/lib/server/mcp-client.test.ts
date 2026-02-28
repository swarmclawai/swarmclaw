import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import {
  jsonSchemaToZod,
  sanitizeName,
  mcpToolsToLangChain,
  disconnectMcpServer,
  connectMcpServer,
} from './mcp-client.ts'

/* ============================================================
 * 1. sanitizeName
 * ============================================================ */

describe('sanitizeName', () => {
  it('strips spaces, hyphens, dots → underscores', () => {
    assert.equal(sanitizeName('my-server.name here'), 'my_server_name_here')
  })

  it('preserves alphanumeric and underscores', () => {
    assert.equal(sanitizeName('abc_123_XYZ'), 'abc_123_XYZ')
  })

  it('empty string stays empty', () => {
    assert.equal(sanitizeName(''), '')
  })

  it('replaces all special characters', () => {
    assert.equal(sanitizeName('a@b#c$d%e'), 'a_b_c_d_e')
  })
})

/* ============================================================
 * 2. jsonSchemaToZod
 * ============================================================ */

describe('jsonSchemaToZod', () => {
  it('empty/null schema returns empty z.object', () => {
    const s1 = jsonSchemaToZod(null)
    assert.deepEqual(s1.parse({}), {})

    const s2 = jsonSchemaToZod(undefined)
    assert.deepEqual(s2.parse({}), {})

    const s3 = jsonSchemaToZod({})
    assert.deepEqual(s3.parse({}), {})
  })

  it('simple string property', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    })
    assert.deepEqual(schema.parse({ name: 'hello' }), { name: 'hello' })

    const bad = schema.safeParse({ name: 123 })
    assert.equal(bad.success, false)
  })

  it('simple number property', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: { count: { type: 'number' } },
      required: ['count'],
    })
    assert.deepEqual(schema.parse({ count: 42 }), { count: 42 })
  })

  it('integer maps to z.number()', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: { age: { type: 'integer' } },
      required: ['age'],
    })
    assert.deepEqual(schema.parse({ age: 25 }), { age: 25 })
  })

  it('boolean property', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: { active: { type: 'boolean' } },
      required: ['active'],
    })
    assert.deepEqual(schema.parse({ active: true }), { active: true })
  })

  it('required vs optional properties', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
      required: ['name'],
    })

    // name required, age optional
    assert.deepEqual(schema.parse({ name: 'Alice' }), { name: 'Alice' })

    const bad = schema.safeParse({})
    assert.equal(bad.success, false)

    // with both fields
    assert.deepEqual(schema.parse({ name: 'Alice', age: 30 }), { name: 'Alice', age: 30 })
  })

  it('nested object schema', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: {
        address: {
          type: 'object',
          properties: {
            city: { type: 'string' },
            zip: { type: 'string' },
          },
          required: ['city'],
        },
      },
      required: ['address'],
    })
    const result = schema.parse({ address: { city: 'NYC' } })
    assert.deepEqual(result, { address: { city: 'NYC' } })
  })

  it('array properties', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: {
        tags: { type: 'array' },
      },
      required: ['tags'],
    })
    assert.deepEqual(schema.parse({ tags: ['a', 'b'] }), { tags: ['a', 'b'] })
  })

  it('unknown type falls through to z.any()', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: {
        data: { type: 'fancyType' },
      },
      required: ['data'],
    })
    // z.any() accepts anything
    assert.deepEqual(schema.parse({ data: 'whatever' }), { data: 'whatever' })
    assert.deepEqual(schema.parse({ data: 42 }), { data: 42 })
    assert.deepEqual(schema.parse({ data: null }), { data: null })
  })

  it('schema with required array properly marks fields', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { type: 'string' },
        c: { type: 'string' },
      },
      required: ['a', 'c'],
    })
    // a and c required, b optional
    const result = schema.parse({ a: 'x', c: 'z' })
    assert.deepEqual(result, { a: 'x', c: 'z' })

    const bad = schema.safeParse({ a: 'x' }) // missing c
    assert.equal(bad.success, false)
  })

  it('no properties key returns empty object schema', () => {
    const schema = jsonSchemaToZod({ type: 'object' })
    assert.deepEqual(schema.parse({}), {})
  })

  it('prop with no type returns z.any()', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: {
        mystery: {},
      },
      required: ['mystery'],
    })
    assert.deepEqual(schema.parse({ mystery: 'anything' }), { mystery: 'anything' })
  })
})

/* ============================================================
 * 3. mcpToolsToLangChain
 * ============================================================ */

describe('mcpToolsToLangChain', () => {
  function makeMockClient(tools: any[], callToolResult?: any) {
    return {
      listTools: async () => ({ tools }),
      callTool: async (args: any) => callToolResult ?? { content: [] },
    }
  }

  it('prefixes tool names with mcp_{sanitized_server}_{tool_name}', async () => {
    const client = makeMockClient([
      { name: 'read_file', description: 'Reads a file', inputSchema: { type: 'object', properties: {} } },
    ])
    const tools = await mcpToolsToLangChain(client, 'my-server')
    assert.equal(tools.length, 1)
    assert.equal(tools[0].name, 'mcp_my_server_read_file')
  })

  it('passes tool descriptions through', async () => {
    const client = makeMockClient([
      { name: 'tool1', description: 'My cool tool', inputSchema: { type: 'object', properties: {} } },
    ])
    const tools = await mcpToolsToLangChain(client, 'srv')
    assert.equal(tools[0].description, 'My cool tool')
  })

  it('uses default description when none provided', async () => {
    const client = makeMockClient([
      { name: 'tool1', inputSchema: { type: 'object', properties: {} } },
    ])
    const tools = await mcpToolsToLangChain(client, 'srv')
    assert.equal(tools[0].description, 'MCP tool: tool1')
  })

  it('tool execution calls client.callTool with correct args', async () => {
    let captured: any = null
    const client = {
      listTools: async () => ({
        tools: [
          { name: 'greet', description: 'Greets', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
        ],
      }),
      callTool: async (args: any) => {
        captured = args
        return { content: [{ type: 'text', text: 'Hello!' }] }
      },
    }
    const tools = await mcpToolsToLangChain(client, 'test')
    const result = await tools[0].invoke({ name: 'World' })
    assert.deepEqual(captured, { name: 'greet', arguments: { name: 'World' } })
  })

  it('joins text content parts', async () => {
    const client = makeMockClient(
      [{ name: 't', description: 'd', inputSchema: { type: 'object', properties: {} } }],
      { content: [{ type: 'text', text: 'line1' }, { type: 'text', text: 'line2' }, { type: 'image', data: 'x' }] }
    )
    const tools = await mcpToolsToLangChain(client, 'srv')
    const result = await tools[0].invoke({})
    assert.equal(result, 'line1\nline2')
  })

  it('returns (no output) when no text content', async () => {
    const client = makeMockClient(
      [{ name: 't', description: 'd', inputSchema: { type: 'object', properties: {} } }],
      { content: [{ type: 'image', data: 'x' }] }
    )
    const tools = await mcpToolsToLangChain(client, 'srv')
    const result = await tools[0].invoke({})
    assert.equal(result, '(no output)')
  })

  it('returns (no output) when content is empty', async () => {
    const client = makeMockClient(
      [{ name: 't', description: 'd', inputSchema: { type: 'object', properties: {} } }],
      { content: [] }
    )
    const tools = await mcpToolsToLangChain(client, 'srv')
    const result = await tools[0].invoke({})
    assert.equal(result, '(no output)')
  })

  it('returns (no output) when content is undefined', async () => {
    const client = makeMockClient(
      [{ name: 't', description: 'd', inputSchema: { type: 'object', properties: {} } }],
      {}
    )
    const tools = await mcpToolsToLangChain(client, 'srv')
    const result = await tools[0].invoke({})
    assert.equal(result, '(no output)')
  })

  it('handles multiple tools', async () => {
    const client = makeMockClient([
      { name: 'a', description: 'Tool A', inputSchema: { type: 'object', properties: {} } },
      { name: 'b', description: 'Tool B', inputSchema: { type: 'object', properties: {} } },
      { name: 'c', description: 'Tool C', inputSchema: { type: 'object', properties: {} } },
    ])
    const tools = await mcpToolsToLangChain(client, 'x')
    assert.equal(tools.length, 3)
    assert.equal(tools[0].name, 'mcp_x_a')
    assert.equal(tools[1].name, 'mcp_x_b')
    assert.equal(tools[2].name, 'mcp_x_c')
  })
})

/* ============================================================
 * 4. disconnectMcpServer
 * ============================================================ */

describe('disconnectMcpServer', () => {
  it('calls close on both client and transport', async () => {
    let clientClosed = false
    let transportClosed = false
    const client = { close: async () => { clientClosed = true } }
    const transport = { close: async () => { transportClosed = true } }
    await disconnectMcpServer(client, transport)
    assert.equal(clientClosed, true)
    assert.equal(transportClosed, true)
  })

  it('does not throw if client.close fails', async () => {
    const client = { close: async () => { throw new Error('boom') } }
    const transport = { close: async () => {} }
    await assert.doesNotReject(() => disconnectMcpServer(client, transport))
  })

  it('does not throw if transport.close fails', async () => {
    const client = { close: async () => {} }
    const transport = { close: async () => { throw new Error('boom') } }
    await assert.doesNotReject(() => disconnectMcpServer(client, transport))
  })

  it('does not throw if both close fail', async () => {
    const client = { close: async () => { throw new Error('a') } }
    const transport = { close: async () => { throw new Error('b') } }
    await assert.doesNotReject(() => disconnectMcpServer(client, transport))
  })
})

/* ============================================================
 * 5. connectMcpServer
 * ============================================================ */

describe('connectMcpServer', () => {
  it('throws on unsupported transport type', async () => {
    await assert.rejects(
      () => connectMcpServer({ transport: 'websocket' as any, name: 'test', id: 'x', createdAt: 0, updatedAt: 0 }),
      { message: 'Unsupported MCP transport: websocket' }
    )
  })
})
