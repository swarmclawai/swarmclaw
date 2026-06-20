import assert from 'node:assert/strict'
import test from 'node:test'

import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

interface OpenRouterContextResult {
  contextWindow: number | null
  fetchCalls?: number
}

function runOpenRouterContextScript(script: string): OpenRouterContextResult {
  return runWithTempDataDir<OpenRouterContextResult>(script, {
    prefix: 'swarmclaw-openrouter-context-',
  })
}

test('exact OpenRouter model ID returns cached context length', () => {
  const output = runOpenRouterContextScript(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const cachePath = path.join(process.env.DATA_DIR, 'openrouter-model-context.json')
    fs.writeFileSync(cachePath, JSON.stringify({
      loadedAt: Date.now(),
      models: { 'minimax/minimax-m3': 524288 },
    }))

    const modImport = await import('./src/lib/server/openrouter-model-context')
    const mod = modImport.default || modImport
    globalThis.fetch = async () => {
      throw new Error('fetch should not run when cache is fresh')
    }

    await mod.ensureOpenRouterModelContextCache('openrouter')
    console.log(JSON.stringify({
      contextWindow: mod.getCachedOpenRouterContextWindow('openrouter', 'minimax/minimax-m3'),
    }))
  `)

  assert.equal(output.contextWindow, 524_288)
})

test('top_provider.context_length is preferred over context_length', () => {
  const output = runOpenRouterContextScript(`
    const modImport = await import('./src/lib/server/openrouter-model-context')
    const mod = modImport.default || modImport
    globalThis.fetch = async () => new Response(JSON.stringify({
      data: [{
        id: 'provider/model-a',
        context_length: 8192,
        top_provider: { context_length: 131072 },
      }],
    }), { status: 200 })

    await mod.ensureOpenRouterModelContextCache('openrouter')
    console.log(JSON.stringify({
      contextWindow: mod.getCachedOpenRouterContextWindow('openrouter', 'provider/model-a'),
    }))
  `)

  assert.equal(output.contextWindow, 131_072)
})

test('unique suffix match works for unprefixed model IDs', () => {
  const output = runOpenRouterContextScript(`
    const modImport = await import('./src/lib/server/openrouter-model-context')
    const mod = modImport.default || modImport
    globalThis.fetch = async () => new Response(JSON.stringify({
      data: [{ id: 'google/gemini-2.5-pro', context_length: 1048576 }],
    }), { status: 200 })

    await mod.ensureOpenRouterModelContextCache('openrouter')
    console.log(JSON.stringify({
      contextWindow: mod.getCachedOpenRouterContextWindow('openrouter', 'gemini-2.5-pro'),
    }))
  `)

  assert.equal(output.contextWindow, 1_048_576)
})

test('ambiguous suffix match returns null', () => {
  const output = runOpenRouterContextScript(`
    const modImport = await import('./src/lib/server/openrouter-model-context')
    const mod = modImport.default || modImport
    globalThis.fetch = async () => new Response(JSON.stringify({
      data: [
        { id: 'provider-a/shared-model', context_length: 32000 },
        { id: 'provider-b/shared-model', context_length: 64000 },
      ],
    }), { status: 200 })

    await mod.ensureOpenRouterModelContextCache('openrouter')
    console.log(JSON.stringify({
      contextWindow: mod.getCachedOpenRouterContextWindow('openrouter', 'shared-model'),
    }))
  `)

  assert.equal(output.contextWindow, null)
})

test('non-OpenRouter provider returns null', () => {
  const output = runOpenRouterContextScript(`
    const modImport = await import('./src/lib/server/openrouter-model-context')
    const mod = modImport.default || modImport
    console.log(JSON.stringify({
      contextWindow: mod.getCachedOpenRouterContextWindow('openai', 'minimax/minimax-m3'),
    }))
  `)

  assert.equal(output.contextWindow, null)
})

test('failed fetch does not throw', () => {
  const output = runOpenRouterContextScript(`
    const modImport = await import('./src/lib/server/openrouter-model-context')
    const mod = modImport.default || modImport
    let fetchCalls = 0
    globalThis.fetch = async () => {
      fetchCalls += 1
      throw new Error('network down')
    }

    await mod.ensureOpenRouterModelContextCache('openrouter')
    console.log(JSON.stringify({
      contextWindow: mod.getCachedOpenRouterContextWindow('openrouter', 'minimax/minimax-m3'),
      fetchCalls,
    }))
  `)

  assert.equal(output.contextWindow, null)
  assert.equal(output.fetchCalls, 1)
})

test('timed out fetch does not throw', () => {
  const output = runOpenRouterContextScript(`
    const modImport = await import('./src/lib/server/openrouter-model-context')
    const mod = modImport.default || modImport
    let fetchCalls = 0
    globalThis.fetch = async (_input, init) => {
      fetchCalls += 1
      await new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
      })
    }

    await mod.ensureOpenRouterModelContextCache('openrouter')
    console.log(JSON.stringify({
      contextWindow: mod.getCachedOpenRouterContextWindow('openrouter', 'minimax/minimax-m3'),
      fetchCalls,
    }))
  `)

  assert.equal(output.contextWindow, null)
  assert.equal(output.fetchCalls, 1)
})

test('stale cache is ignored', () => {
  const output = runOpenRouterContextScript(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const cachePath = path.join(process.env.DATA_DIR, 'openrouter-model-context.json')
    fs.writeFileSync(cachePath, JSON.stringify({
      loadedAt: Date.now() - (25 * 60 * 60 * 1000),
      models: { 'minimax/minimax-m3': 524288 },
    }))

    const modImport = await import('./src/lib/server/openrouter-model-context')
    const mod = modImport.default || modImport
    let fetchCalls = 0
    globalThis.fetch = async () => {
      fetchCalls += 1
      throw new Error('network down')
    }

    await mod.ensureOpenRouterModelContextCache('openrouter')
    console.log(JSON.stringify({
      contextWindow: mod.getCachedOpenRouterContextWindow('openrouter', 'minimax/minimax-m3'),
      fetchCalls,
    }))
  `)

  assert.equal(output.contextWindow, null)
  assert.equal(output.fetchCalls, 1)
})

test('cache write failure does not throw', () => {
  const output = runOpenRouterContextScript(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const cachePath = path.join(process.env.DATA_DIR, 'openrouter-model-context.json')
    fs.mkdirSync(cachePath)

    const modImport = await import('./src/lib/server/openrouter-model-context')
    const mod = modImport.default || modImport
    globalThis.fetch = async () => new Response(JSON.stringify({
      data: [{ id: 'provider/model-a', context_length: 65536 }],
    }), { status: 200 })

    await mod.ensureOpenRouterModelContextCache('openrouter')
    console.log(JSON.stringify({
      contextWindow: mod.getCachedOpenRouterContextWindow('openrouter', 'provider/model-a'),
    }))
  `)

  assert.equal(output.contextWindow, 65_536)
})
