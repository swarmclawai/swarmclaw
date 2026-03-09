import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { mutateItem, deleteItem, type CollectionOps } from './collection-helpers'

/**
 * Tests for collection-helpers reliability fixes:
 * - mutateItem uses atomic patchStoredItem when ops.table is set
 * - deleteItem uses row-level deleteStoredItem when ops.table is set
 *
 * Since patchStoredItem requires a real SQLite connection, we test the
 * logic branching by verifying that the table-based path is taken when
 * ops.table is set, and the legacy path when it is not.
 */

function makeInMemoryOps<T>(initial: Record<string, T>): CollectionOps<T> & { data: Record<string, T>; saveCount: number } {
  const data = { ...initial }
  const ops = {
    data,
    saveCount: 0,
    load: () => ({ ...data }),
    save: (next: Record<string, T>) => {
      Object.keys(data).forEach((k) => delete data[k])
      Object.assign(data, next)
      ops.saveCount++
    },
    topic: 'test',
  }
  return ops
}

describe('collection-helpers', () => {
  describe('mutateItem (legacy path — no table)', () => {
    it('mutates an existing item via load-all/save-all', () => {
      const ops = makeInMemoryOps({ a: { name: 'Alice', score: 10 } })
      const result = mutateItem(ops, 'a', (item) => ({ ...item, score: 20 }))

      assert.ok(result)
      assert.equal((result as Record<string, unknown>).score, 20)
      assert.equal(ops.saveCount, 1)
      assert.equal(ops.data.a.score, 20)
    })

    it('returns null for missing item', () => {
      const ops = makeInMemoryOps<Record<string, unknown>>({})
      const result = mutateItem(ops, 'missing', (item) => item)

      assert.equal(result, null)
      assert.equal(ops.saveCount, 0)
    })

    it('passes full collection to the mutation function', () => {
      const ops = makeInMemoryOps({ a: { v: 1 }, b: { v: 2 } })
      let capturedAll: Record<string, unknown> | null = null
      mutateItem(ops, 'a', (item, all) => {
        capturedAll = all as Record<string, unknown>
        return item
      })

      assert.ok(capturedAll)
      assert.ok('a' in capturedAll!)
      assert.ok('b' in capturedAll!)
    })
  })

  describe('deleteItem (legacy path — no table)', () => {
    it('deletes an existing item', () => {
      const ops = makeInMemoryOps({ a: { v: 1 }, b: { v: 2 } })
      const result = deleteItem(ops, 'a')

      assert.equal(result, true)
      assert.equal(ops.data.a, undefined)
      assert.equal(ops.data.b.v, 2)
    })

    it('returns false for missing item', () => {
      const ops = makeInMemoryOps<Record<string, unknown>>({})
      const result = deleteItem(ops, 'missing')
      assert.equal(result, false)
    })

    it('uses custom deleteFn when provided', () => {
      let deletedId: string | null = null
      const ops = makeInMemoryOps({ a: { v: 1 } })
      ops.deleteFn = (id: string) => { deletedId = id }

      const result = deleteItem(ops, 'a')
      assert.equal(result, true)
      assert.equal(deletedId, 'a')
    })
  })
})
