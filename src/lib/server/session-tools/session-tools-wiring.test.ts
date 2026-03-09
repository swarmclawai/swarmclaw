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

  it('primitive tool builders are exported', async () => {
    const document = await import('./document')
    const extract = await import('./extract')
    const table = await import('./table')
    const crawl = await import('./crawl')
    const mailbox = await import('./mailbox')
    const humanLoop = await import('./human-loop')
    const sandbox = await import('./sandbox')
    assert.equal(typeof document.buildDocumentTools, 'function')
    assert.equal(typeof extract.buildExtractTools, 'function')
    assert.equal(typeof table.buildTableTools, 'function')
    assert.equal(typeof crawl.buildCrawlTools, 'function')
    assert.equal(typeof mailbox.buildMailboxTools, 'function')
    assert.equal(typeof humanLoop.buildHumanLoopTools, 'function')
    assert.equal(typeof sandbox.buildSandboxTools, 'function')
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

  it('sandbox builder exposes only the local Deno sandbox tools', async () => {
    const { buildSandboxTools } = await import('./sandbox')
    const bctx: import('./context').ToolBuildContext = {
      cwd: process.cwd(),
      ctx: { sessionId: 'sandbox-test' },
      hasPlugin: (name) => name === 'sandbox',
      hasTool: (name) => name === 'sandbox',
      cleanupFns: [],
      commandTimeoutMs: 1_000,
      claudeTimeoutMs: 1_000,
      cliProcessTimeoutMs: 1_000,
      persistDelegateResumeId: () => {},
      readStoredDelegateResumeId: () => null,
      resolveCurrentSession: () => null,
      activePlugins: ['sandbox'],
    }

    const tools = buildSandboxTools(bctx).map((tool) => tool.name).sort()
    assert.deepEqual(tools, ['sandbox_exec', 'sandbox_list_runtimes'])
  })
})

// ---------------------------------------------------------------------------
// 4. Memory tool schema
//    buildMemoryTools calls getMemoryDb() eagerly so we cannot invoke it
//    without a real SQLite DB. Instead we read the source and verify the
//    declared action enum matches the current JSON schema definition.
// ---------------------------------------------------------------------------
describe('memory tool knowledge actions (source verification)', () => {
  it('action enum in memory.ts includes the declared base actions', async () => {
    const fs = await import('fs')
    const src = fs.readFileSync(
      new URL('./memory', import.meta.url).pathname,
      'utf-8',
    )

    const enumMatch = src.match(/action:\s*\{\s*type:\s*'string',\s*enum:\s*\[([^\]]+)\]/s)
    assert.ok(enumMatch, 'Should find the action enum in the memory tool schema')

    const enumBody = enumMatch![1]
    const expectedActions = ['store', 'get', 'search', 'list', 'delete']
    for (const action of expectedActions) {
      assert.ok(
        enumBody.includes(`'${action}'`),
        `action enum should include '${action}'`,
      )
    }
  })

  it('action enum does not advertise removed knowledge actions', async () => {
    const fs = await import('fs')
    const src = fs.readFileSync(
      new URL('./memory', import.meta.url).pathname,
      'utf-8',
    )

    const enumMatch = src.match(/action:\s*\{\s*type:\s*'string',\s*enum:\s*\[([^\]]+)\]/s)
    assert.ok(enumMatch)
    const enumBody = enumMatch![1]

    assert.equal(enumBody.includes("'knowledge_store'"), false)
    assert.equal(enumBody.includes("'knowledge_search'"), false)
  })

  it('declares the narrow OpenClaw-style memory tool names', async () => {
    const fs = await import('fs')
    const src = fs.readFileSync(
      new URL('./memory', import.meta.url).pathname,
      'utf-8',
    )

    for (const toolName of ['memory_search', 'memory_get', 'memory_store', 'memory_update']) {
      assert.ok(src.includes(`name: '${toolName}'`), `memory.ts should declare ${toolName}`)
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
      new URL('./index', import.meta.url).pathname,
      'utf-8',
    )
    assert.ok(src.includes('mcpServerIds'), 'index.ts should reference mcpServerIds')
    assert.ok(src.includes('connectMcpServer'), 'index.ts should connect configured MCP servers')
    assert.ok(src.includes('mcpToolsToLangChain'), 'index.ts should inject MCP tools dynamically')
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
    const result = safePath('/home/user/project', 'src/index')
    assert.equal(result, '/home/user/project/src/index')
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
