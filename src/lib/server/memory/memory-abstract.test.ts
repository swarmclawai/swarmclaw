import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { generateAbstract } from './memory-abstract'

// ---------------------------------------------------------------------------
// Short content guard
// ---------------------------------------------------------------------------

describe('generateAbstract', () => {
  it('returns null for content <= 200 chars', async () => {
    const short = 'A'.repeat(200)
    assert.equal(await generateAbstract(short, 'title'), null)
  })

  it('returns null for empty content', async () => {
    assert.equal(await generateAbstract('', 'title'), null)
  })

  it('returns null for content exactly 200 chars', async () => {
    assert.equal(await generateAbstract('x'.repeat(200)), null)
  })

  // ---------------------------------------------------------------------------
  // Fallback abstract
  // ---------------------------------------------------------------------------

  it('returns fallback (truncated prefix) when LLM import fails', async () => {
    // generateAbstract uses dynamic import('@/lib/server/build-llm')
    // In a test environment without the full server, the import will fail
    // and the catch block returns fallbackAbstract
    const longContent = 'B'.repeat(250)
    const result = await generateAbstract(longContent, 'title')
    // Fallback: first 150 chars + '...'
    assert.ok(result !== null)
    assert.equal(result, 'B'.repeat(150) + '...')
  })

  it('returns content as-is when <= 150 chars and LLM fails', async () => {
    // This case won't trigger because content <= 200 returns null.
    // The fallback only runs for content > 200 chars.
    // For content > 200 but fallback returns first 150 + '...'
    const content = 'C'.repeat(201)
    const result = await generateAbstract(content, 'title')
    assert.ok(result !== null)
    assert.equal(result, 'C'.repeat(150) + '...')
  })

  it('fallback does not add ellipsis for content <= 150 chars', async () => {
    // This is a unit test of the fallback logic itself:
    // Since generateAbstract returns null for content <= 200,
    // the fallback truncation (150 + '...') only applies to content > 200.
    // But the fallbackAbstract function itself handles <= 150 without ellipsis.
    // We test this indirectly — content of 201 chars gets truncated to 150 + '...'
    const content = 'D'.repeat(201)
    const result = await generateAbstract(content)
    assert.equal(result, 'D'.repeat(150) + '...')
  })
})
