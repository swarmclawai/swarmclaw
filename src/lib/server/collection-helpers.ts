import { NextResponse } from 'next/server'
import { notify } from './ws-hub'
import { deleteStoredItem, patchStoredItem, type StorageCollection } from './storage'

export interface CollectionOps<T> {
  load: () => Record<string, T>
  save: (data: Record<string, T>) => void
  deleteFn?: (id: string) => void
  topic?: string
  /** When set, mutateItem/deleteItem use row-level upsert/delete instead of save-all. */
  table?: StorageCollection
}

/**
 * Load → 404 check → mutate → upsert single row → notify.
 * `fn` receives the item and the full collection, returns the updated item.
 *
 * When `ops.table` is set, uses an atomic read-modify-write transaction via
 * patchStoredItem to prevent concurrent writers from losing each other's updates.
 */
export function mutateItem<T>(
  ops: CollectionOps<T>,
  id: string,
  fn: (item: T, all: Record<string, T>) => T,
): T | null {
  if (ops.table) {
    // Atomic path: read + mutate + write inside a single SQLite transaction
    const result = patchStoredItem<T>(ops.table, id, (current) => {
      if (current === null) return null
      // Load full collection for the fn callback (rare code paths need it)
      const all = ops.load()
      all[id] = current
      return fn(current, all)
    })
    if (result !== null && ops.topic) notify(ops.topic)
    return result
  }
  // Legacy path: load-all → mutate → save-all (no table set)
  const all = ops.load()
  if (!all[id]) return null
  all[id] = fn(all[id], all)
  ops.save(all)
  if (ops.topic) notify(ops.topic)
  return all[id]
}

/**
 * Load → 404 check → delete single row → notify.
 * Uses `ops.deleteFn` if provided, then `ops.table` for row-level delete,
 * otherwise inline `delete` + `save`.
 */
export function deleteItem<T>(
  ops: CollectionOps<T>,
  id: string,
): boolean {
  const all = ops.load()
  if (!all[id]) return false
  if (ops.deleteFn) {
    ops.deleteFn(id)
  } else if (ops.table) {
    deleteStoredItem(ops.table, id)
  } else {
    delete all[id]
    ops.save(all)
  }
  if (ops.topic) notify(ops.topic)
  return true
}

export function notFound(msg = 'Not found') {
  return NextResponse.json({ error: msg }, { status: 404 })
}

export function badRequest(msg: string) {
  return NextResponse.json({ error: msg }, { status: 400 })
}
