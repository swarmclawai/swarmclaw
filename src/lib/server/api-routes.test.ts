import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

// ---------------------------------------------------------------------------
// Helpers — validate request body shapes the same way the route handlers do
// ---------------------------------------------------------------------------

function validateKnowledgePost(body: unknown): { ok: true; data: { title: string; content: string; tags?: string[] } } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Invalid JSON body.' }
  }
  const { title, content, tags } = body as Record<string, unknown>
  if (typeof title !== 'string' || !title.trim()) {
    return { ok: false, error: 'title is required.' }
  }
  if (typeof content !== 'string') {
    return { ok: false, error: 'content is required.' }
  }
  const normalizedTags = Array.isArray(tags)
    ? (tags as unknown[]).filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    : undefined
  return { ok: true, data: { title: title.trim(), content, tags: normalizedTags } }
}

function validateKnowledgePut(body: unknown): { ok: true; updates: Record<string, unknown> } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Invalid JSON body.' }
  }
  const { title, content, tags } = body as Record<string, unknown>
  const updates: Record<string, unknown> = {}
  if (typeof title === 'string' && title.trim()) updates.title = title.trim()
  if (typeof content === 'string') updates.content = content
  if (Array.isArray(tags)) {
    updates.tags = (tags as unknown[]).filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
  }
  return { ok: true, updates }
}

type McpTransport = 'stdio' | 'sse' | 'streamable-http'

const VALID_TRANSPORTS: McpTransport[] = ['stdio', 'sse', 'streamable-http']

interface McpServerBody {
  name: string
  transport: McpTransport
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
}

function validateMcpServerPost(body: unknown): { ok: true; data: McpServerBody } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Invalid JSON body.' }
  }
  const b = body as Record<string, unknown>
  if (typeof b.name !== 'string' || !b.name.trim()) {
    return { ok: false, error: 'name is required.' }
  }
  if (typeof b.transport !== 'string' || !VALID_TRANSPORTS.includes(b.transport as McpTransport)) {
    return { ok: false, error: 'transport must be one of: stdio, sse, streamable-http.' }
  }
  const transport = b.transport as McpTransport
  if (transport === 'stdio' && (typeof b.command !== 'string' || !b.command.trim())) {
    return { ok: false, error: 'command is required for stdio transport.' }
  }
  if ((transport === 'sse' || transport === 'streamable-http') && (typeof b.url !== 'string' || !b.url.trim())) {
    return { ok: false, error: 'url is required for sse/streamable-http transport.' }
  }
  return { ok: true, data: b as unknown as McpServerBody }
}

function parseKnowledgeQueryParams(url: string) {
  const { searchParams } = new URL(url)
  const q = searchParams.get('q')
  const tagsParam = searchParams.get('tags')
  const limitParam = searchParams.get('limit')
  const tags = tagsParam ? tagsParam.split(',').map((t) => t.trim()).filter(Boolean) : undefined
  const limit = limitParam ? Math.max(1, Math.min(500, Number.parseInt(limitParam, 10) || 50)) : undefined
  return { q, tags, limit }
}

// ---------------------------------------------------------------------------
// Route source-code existence checks
// ---------------------------------------------------------------------------

const thisFile = new URL(import.meta.url).pathname
const routeDir = path.resolve(path.dirname(thisFile), '../../app/api')

function readRoute(...segments: string[]): string {
  return fs.readFileSync(path.join(routeDir, ...segments), 'utf-8')
}

// ===========================================================================
// Tests
// ===========================================================================

describe('Knowledge API contract', () => {
  // --- POST validation ---------------------------------------------------
  describe('POST body validation', () => {
    it('accepts valid body with title and content', () => {
      const result = validateKnowledgePost({ title: 'My doc', content: 'Some text' })
      assert.equal(result.ok, true)
      if (result.ok) {
        assert.equal(result.data.title, 'My doc')
        assert.equal(result.data.content, 'Some text')
      }
    })

    it('rejects missing title', () => {
      const result = validateKnowledgePost({ content: 'Hello' })
      assert.equal(result.ok, false)
      if (!result.ok) assert.match(result.error, /title/)
    })

    it('rejects empty-string title', () => {
      const result = validateKnowledgePost({ title: '   ', content: 'Hello' })
      assert.equal(result.ok, false)
      if (!result.ok) assert.match(result.error, /title/)
    })

    it('rejects missing content', () => {
      const result = validateKnowledgePost({ title: 'T' })
      assert.equal(result.ok, false)
      if (!result.ok) assert.match(result.error, /content/)
    })

    it('rejects non-object bodies', () => {
      assert.equal(validateKnowledgePost(null).ok, false)
      assert.equal(validateKnowledgePost([]).ok, false)
      assert.equal(validateKnowledgePost('str').ok, false)
    })

    it('normalizes tags — filters out non-strings and empty strings', () => {
      const result = validateKnowledgePost({ title: 'T', content: 'C', tags: ['a', '', 42, 'b', '  '] })
      assert.equal(result.ok, true)
      if (result.ok) {
        assert.deepEqual(result.data.tags, ['a', 'b'])
      }
    })

    it('trims title', () => {
      const result = validateKnowledgePost({ title: '  Trimmed  ', content: 'C' })
      assert.equal(result.ok, true)
      if (result.ok) assert.equal(result.data.title, 'Trimmed')
    })
  })

  // --- PUT validation ----------------------------------------------------
  describe('PUT body validation', () => {
    it('accepts partial updates (title only)', () => {
      const result = validateKnowledgePut({ title: 'New title' })
      assert.equal(result.ok, true)
      if (result.ok) {
        assert.equal(result.updates.title, 'New title')
        assert.equal(result.updates.content, undefined)
      }
    })

    it('accepts partial updates (content only)', () => {
      const result = validateKnowledgePut({ content: 'New content' })
      assert.equal(result.ok, true)
      if (result.ok) {
        assert.equal(result.updates.content, 'New content')
        assert.equal(result.updates.title, undefined)
      }
    })

    it('ignores empty-string title in PUT (does not overwrite)', () => {
      const result = validateKnowledgePut({ title: '' })
      assert.equal(result.ok, true)
      if (result.ok) assert.equal(result.updates.title, undefined)
    })

    it('rejects non-object bodies', () => {
      assert.equal(validateKnowledgePut(null).ok, false)
      assert.equal(validateKnowledgePut([1, 2]).ok, false)
    })

    it('normalizes tags in PUT', () => {
      const result = validateKnowledgePut({ tags: ['x', 99, '', 'y'] })
      assert.equal(result.ok, true)
      if (result.ok) assert.deepEqual(result.updates.tags, ['x', 'y'])
    })
  })

  // --- GET query parsing -------------------------------------------------
  describe('GET query param parsing', () => {
    it('parses q param', () => {
      const { q } = parseKnowledgeQueryParams('http://localhost/api/knowledge?q=hello')
      assert.equal(q, 'hello')
    })

    it('parses tags as comma-separated list', () => {
      const { tags } = parseKnowledgeQueryParams('http://localhost/api/knowledge?tags=a,b,%20c')
      assert.deepEqual(tags, ['a', 'b', 'c'])
    })

    it('filters empty tag segments', () => {
      const { tags } = parseKnowledgeQueryParams('http://localhost/api/knowledge?tags=a,,b,')
      assert.deepEqual(tags, ['a', 'b'])
    })

    it('returns undefined tags when param is absent', () => {
      const { tags } = parseKnowledgeQueryParams('http://localhost/api/knowledge')
      assert.equal(tags, undefined)
    })

    it('clamps limit between 1 and 500', () => {
      // parseInt('0') === 0 which is falsy, so || 50 kicks in => max(1,min(500,50)) = 50
      assert.equal(parseKnowledgeQueryParams('http://localhost/api/knowledge?limit=0').limit, 50)
      // parseInt('-5') === -5 which is truthy, so max(1, min(500, -5)) = max(1, -5) = 1
      assert.equal(parseKnowledgeQueryParams('http://localhost/api/knowledge?limit=-5').limit, 1)
      assert.equal(parseKnowledgeQueryParams('http://localhost/api/knowledge?limit=9999').limit, 500)
      assert.equal(parseKnowledgeQueryParams('http://localhost/api/knowledge?limit=50').limit, 50)
    })

    it('defaults to 50 for non-numeric limit', () => {
      assert.equal(parseKnowledgeQueryParams('http://localhost/api/knowledge?limit=abc').limit, 50)
    })

    it('returns undefined limit when param is absent', () => {
      assert.equal(parseKnowledgeQueryParams('http://localhost/api/knowledge').limit, undefined)
    })
  })

  // --- Route file structure -----------------------------------------------
  describe('route file exports', () => {
    it('knowledge/route.ts exports GET and POST', () => {
      const src = readRoute('knowledge', 'route.ts')
      assert.match(src, /export\s+async\s+function\s+GET/)
      assert.match(src, /export\s+async\s+function\s+POST/)
    })

    it('knowledge/[id]/route.ts exports GET, PUT, DELETE', () => {
      const src = readRoute('knowledge', '[id]', 'route.ts')
      assert.match(src, /export\s+async\s+function\s+GET/)
      assert.match(src, /export\s+async\s+function\s+PUT/)
      assert.match(src, /export\s+async\s+function\s+DELETE/)
    })
  })
})

describe('MCP Server API contract', () => {
  // --- POST validation ---------------------------------------------------
  describe('POST body validation', () => {
    it('accepts valid stdio server', () => {
      const result = validateMcpServerPost({
        name: 'My MCP',
        transport: 'stdio',
        command: 'node',
        args: ['server.js'],
      })
      assert.equal(result.ok, true)
      if (result.ok) {
        assert.equal(result.data.name, 'My MCP')
        assert.equal(result.data.transport, 'stdio')
        assert.equal(result.data.command, 'node')
      }
    })

    it('accepts valid sse server', () => {
      const result = validateMcpServerPost({
        name: 'SSE Server',
        transport: 'sse',
        url: 'http://localhost:8080/sse',
      })
      assert.equal(result.ok, true)
    })

    it('accepts valid streamable-http server', () => {
      const result = validateMcpServerPost({
        name: 'HTTP Server',
        transport: 'streamable-http',
        url: 'http://localhost:8080/mcp',
      })
      assert.equal(result.ok, true)
    })

    it('rejects missing name', () => {
      const result = validateMcpServerPost({ transport: 'stdio', command: 'node' })
      assert.equal(result.ok, false)
      if (!result.ok) assert.match(result.error, /name/)
    })

    it('rejects missing transport', () => {
      const result = validateMcpServerPost({ name: 'Server' })
      assert.equal(result.ok, false)
      if (!result.ok) assert.match(result.error, /transport/)
    })

    it('rejects invalid transport value', () => {
      const result = validateMcpServerPost({ name: 'S', transport: 'websocket' })
      assert.equal(result.ok, false)
      if (!result.ok) assert.match(result.error, /transport/)
    })

    it('rejects stdio without command', () => {
      const result = validateMcpServerPost({ name: 'S', transport: 'stdio' })
      assert.equal(result.ok, false)
      if (!result.ok) assert.match(result.error, /command/)
    })

    it('rejects sse without url', () => {
      const result = validateMcpServerPost({ name: 'S', transport: 'sse' })
      assert.equal(result.ok, false)
      if (!result.ok) assert.match(result.error, /url/)
    })

    it('rejects streamable-http without url', () => {
      const result = validateMcpServerPost({ name: 'S', transport: 'streamable-http' })
      assert.equal(result.ok, false)
      if (!result.ok) assert.match(result.error, /url/)
    })

    it('rejects non-object body', () => {
      assert.equal(validateMcpServerPost(null).ok, false)
      assert.equal(validateMcpServerPost('hello').ok, false)
      assert.equal(validateMcpServerPost([]).ok, false)
    })
  })

  // --- Transport enum completeness ----------------------------------------
  describe('transport enum', () => {
    it('includes exactly three valid transport values', () => {
      assert.deepEqual(VALID_TRANSPORTS, ['stdio', 'sse', 'streamable-http'])
      assert.equal(VALID_TRANSPORTS.length, 3)
    })
  })

  // --- Route file structure -----------------------------------------------
  describe('route file exports', () => {
    it('mcp-servers/route.ts exports GET and POST', () => {
      const src = readRoute('mcp-servers', 'route.ts')
      assert.match(src, /export\s+async\s+function\s+GET/)
      assert.match(src, /export\s+async\s+function\s+POST/)
    })

    it('mcp-servers/[id]/route.ts exports GET, PUT, DELETE', () => {
      const src = readRoute('mcp-servers', '[id]', 'route.ts')
      assert.match(src, /export\s+async\s+function\s+GET/)
      assert.match(src, /export\s+async\s+function\s+PUT/)
      assert.match(src, /export\s+async\s+function\s+DELETE/)
    })

    it('MCP POST route assigns an id via crypto.randomBytes', () => {
      const src = readRoute('mcp-servers', 'route.ts')
      assert.match(src, /crypto\.randomBytes/)
    })

    it('MCP PUT route preserves id and sets updatedAt', () => {
      const src = readRoute('mcp-servers', '[id]', 'route.ts')
      assert.match(src, /updatedAt:\s*Date\.now\(\)/)
      // Verify id is pinned (spread then override)
      assert.match(src, /\.\.\.servers\[id\]/)
      assert.match(src, /\bid\b,/)
    })
  })
})
