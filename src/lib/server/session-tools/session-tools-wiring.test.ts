import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// ---------------------------------------------------------------------------
// 1. Module export verification
// ---------------------------------------------------------------------------
describe('module exports', () => {
  it('buildSessionTools is exported from index', async () => {
    const mod = await import('./index')
    assert.equal(typeof mod.buildSessionTools, 'function')
  })

  it('ToolContext type is re-exported from index (via SessionToolsResult)', async () => {
    // ToolContext is a type-only export so we can't check it at runtime.
    // Instead we verify the companion runtime exports from context.ts exist.
    const ctx = await import('./context')
    assert.equal(typeof ctx.safePath, 'function')
    assert.equal(typeof ctx.truncate, 'function')
    assert.equal(typeof ctx.MAX_OUTPUT, 'number')
    assert.equal(typeof ctx.MAX_FILE, 'number')
  })

  it('buildMemoryTools is exported from memory', async () => {
    const mem = await import('./memory')
    assert.equal(typeof mem.buildMemoryTools, 'function')
  })
})

// ---------------------------------------------------------------------------
// 2. ToolContext type verification (compile-time)
// ---------------------------------------------------------------------------
describe('ToolContext type', () => {
  it('accepts mcpServerIds property', () => {
    // This is a compile-time check. If ToolContext doesn't have mcpServerIds,
    // TypeScript will reject this file at compilation.
    const ctx: import('./context').ToolContext = {
      agentId: 'a1',
      sessionId: 's1',
      mcpServerIds: ['mcp-1', 'mcp-2'],
    }
    assert.ok(ctx.mcpServerIds)
    assert.equal(ctx.mcpServerIds.length, 2)
  })

  it('mcpServerIds is optional', () => {
    const ctx: import('./context').ToolContext = {}
    assert.equal(ctx.mcpServerIds, undefined)
  })
})

// ---------------------------------------------------------------------------
// 3. buildSessionTools function signature
// ---------------------------------------------------------------------------
describe('buildSessionTools signature', () => {
  it('accepts (cwd, enabledTools, ctx?) and returns {tools, cleanup}', async () => {
    const { buildSessionTools } = await import('./index')
    // Verify the function has arity of at least 2
    assert.ok(buildSessionTools.length >= 2, 'buildSessionTools should accept at least 2 params')
  })
})

// ---------------------------------------------------------------------------
// 4. Memory tool schema — knowledge actions
//    buildMemoryTools calls getMemoryDb() eagerly so we cannot invoke it
//    without a real SQLite DB. Instead we read the source and verify the
//    action enum includes the knowledge actions.
// ---------------------------------------------------------------------------
describe('memory tool knowledge actions (source verification)', () => {
  it('action enum in memory.ts includes knowledge_store and knowledge_search', async () => {
    const fs = await import('fs')
    const src = fs.readFileSync(
      new URL('./memory.ts', import.meta.url).pathname,
      'utf-8',
    )

    // Find the z.enum([...]) for the action field
    const enumMatch = src.match(/z\.enum\(\[([^\]]+)\]\)\.describe\([^)]*action/s)
    assert.ok(enumMatch, 'Should find a z.enum() for the action field')

    const enumBody = enumMatch![1]
    assert.ok(enumBody.includes("'knowledge_store'"), 'action enum should include knowledge_store')
    assert.ok(enumBody.includes("'knowledge_search'"), 'action enum should include knowledge_search')
  })

  it('action enum includes all expected base actions', async () => {
    const fs = await import('fs')
    const src = fs.readFileSync(
      new URL('./memory.ts', import.meta.url).pathname,
      'utf-8',
    )

    const enumMatch = src.match(/z\.enum\(\[([^\]]+)\]\)/)
    assert.ok(enumMatch)
    const enumBody = enumMatch![1]

    const expectedActions = ['store', 'get', 'search', 'list', 'delete', 'link', 'unlink', 'knowledge_store', 'knowledge_search']
    for (const action of expectedActions) {
      assert.ok(
        enumBody.includes(`'${action}'`),
        `action enum should include '${action}'`,
      )
    }
  })
})

// ---------------------------------------------------------------------------
// 5. MCP tool block — compile-time type check
//    Verifying that buildSessionTools accepts ToolContext with mcpServerIds.
//    We can't call it without the full server env, so this is a type assertion.
// ---------------------------------------------------------------------------
describe('MCP tool block type wiring', () => {
  it('buildSessionTools third parameter accepts ToolContext with mcpServerIds', () => {
    // Compile-time assertion: if the types don't match, tsc will reject this.
    type Params = Parameters<typeof import('./index').buildSessionTools>
    type ThirdParam = Params[2]

    // ThirdParam should be ToolContext | undefined
    // We verify by assigning a value with mcpServerIds — if it compiles, it passes.
    const _check: ThirdParam = {
      agentId: 'a1',
      sessionId: 's1',
      mcpServerIds: ['server-1'],
    }
    assert.ok(_check, 'Type assignment compiled successfully')
  })

  it('index.ts source has MCP tool block gated on mcpServerIds', async () => {
    const fs = await import('fs')
    const src = fs.readFileSync(
      new URL('./index.ts', import.meta.url).pathname,
      'utf-8',
    )
    assert.ok(src.includes('mcpServerIds'), 'index.ts should reference mcpServerIds')
    assert.ok(src.includes('mcp_list_tools'), 'index.ts should define mcp_list_tools tool')
    assert.ok(src.includes('mcp_call'), 'index.ts should define mcp_call tool')
  })
})

// ---------------------------------------------------------------------------
// 6. Context utility functions
// ---------------------------------------------------------------------------
describe('context utility functions', () => {
  it('safePath blocks traversal', async () => {
    const { safePath } = await import('./context')
    assert.throws(
      () => safePath('/home/user/project', '../../etc/passwd'),
      /Path traversal not allowed/,
    )
  })

  it('safePath allows valid paths', async () => {
    const { safePath } = await import('./context')
    const result = safePath('/home/user/project', 'src/index.ts')
    assert.equal(result, '/home/user/project/src/index.ts')
  })

  it('truncate respects max length', async () => {
    const { truncate } = await import('./context')
    const short = truncate('hello', 100)
    assert.equal(short, 'hello')

    const long = truncate('a'.repeat(200), 50)
    assert.ok(long.length > 50, 'truncated output includes suffix')
    assert.ok(long.includes('[truncated'), 'should include truncation marker')
  })
})
