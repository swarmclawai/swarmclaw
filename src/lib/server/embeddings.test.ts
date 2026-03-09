import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

// embeddings.ts exports pure utility functions (cosineSimilarity, serialize/deserialize)
// that don't need DATA_DIR. getEmbedding needs storage — skip that, test pure logic.

// Direct import is safe for the pure math/serialization functions since the module
// only touches storage lazily in getEmbedding().
// However the top-level import of ./storage will trigger DB init,
// so we use dynamic import with SWARMCLAW_BUILD_MODE.

let embeddings: typeof import('./embeddings')

import { before } from 'node:test'

before(async () => {
  process.env.SWARMCLAW_BUILD_MODE = '1'
  embeddings = await import('./embeddings')
})

describe('embeddings - cosineSimilarity', () => {
  it('identical vectors have similarity 1', () => {
    const v = [1, 2, 3, 4, 5]
    const sim = embeddings.cosineSimilarity(v, v)
    assert.ok(Math.abs(sim - 1) < 1e-10, `expected ~1, got ${sim}`)
  })

  it('orthogonal vectors have similarity 0', () => {
    const a = [1, 0, 0]
    const b = [0, 1, 0]
    const sim = embeddings.cosineSimilarity(a, b)
    assert.ok(Math.abs(sim) < 1e-10, `expected ~0, got ${sim}`)
  })

  it('opposite vectors have similarity -1', () => {
    const a = [1, 2, 3]
    const b = [-1, -2, -3]
    const sim = embeddings.cosineSimilarity(a, b)
    assert.ok(Math.abs(sim + 1) < 1e-10, `expected ~-1, got ${sim}`)
  })

  it('different-length vectors return 0', () => {
    const sim = embeddings.cosineSimilarity([1, 2], [1, 2, 3])
    assert.equal(sim, 0)
  })

  it('zero vector returns 0', () => {
    const sim = embeddings.cosineSimilarity([0, 0, 0], [1, 2, 3])
    assert.equal(sim, 0)
  })

  it('both zero vectors return 0', () => {
    const sim = embeddings.cosineSimilarity([0, 0], [0, 0])
    assert.equal(sim, 0)
  })

  it('empty vectors return 0', () => {
    const sim = embeddings.cosineSimilarity([], [])
    assert.equal(sim, 0)
  })
})

describe('embeddings - serialize/deserialize roundtrip', () => {
  it('roundtrips a simple embedding', () => {
    const original = [0.1, 0.2, 0.3, -0.5, 1.0]
    const buf = embeddings.serializeEmbedding(original)
    const restored = embeddings.deserializeEmbedding(buf)

    assert.equal(restored.length, original.length)
    for (let i = 0; i < original.length; i++) {
      assert.ok(Math.abs(restored[i] - original[i]) < 1e-6, `index ${i}: ${restored[i]} vs ${original[i]}`)
    }
  })

  it('roundtrips an empty embedding', () => {
    const buf = embeddings.serializeEmbedding([])
    const restored = embeddings.deserializeEmbedding(buf)
    assert.equal(restored.length, 0)
  })

  it('roundtrips a large embedding (384 dimensions)', () => {
    const original = Array.from({ length: 384 }, (_, i) => Math.sin(i) * 0.5)
    const buf = embeddings.serializeEmbedding(original)
    assert.equal(buf.byteLength, 384 * 4) // Float32 = 4 bytes each
    const restored = embeddings.deserializeEmbedding(buf)
    assert.equal(restored.length, 384)
    for (let i = 0; i < original.length; i++) {
      assert.ok(Math.abs(restored[i] - original[i]) < 1e-6)
    }
  })

  it('serialize produces a Buffer', () => {
    const buf = embeddings.serializeEmbedding([1, 2, 3])
    assert.ok(Buffer.isBuffer(buf))
  })

  it('preserves special float values', () => {
    const original = [0, -0, Infinity, -Infinity]
    const buf = embeddings.serializeEmbedding(original)
    const restored = embeddings.deserializeEmbedding(buf)
    assert.equal(restored[0], 0)
    assert.equal(restored[2], Infinity)
    assert.equal(restored[3], -Infinity)
  })
})
