import { NextResponse } from 'next/server'
import { notify } from './ws-hub'

export interface CollectionOps<T> {
  load: () => Record<string, T>
  save: (data: Record<string, T>) => void
  deleteFn?: (id: string) => void
  topic?: string
}

/**
 * Load → 404 check → mutate → save → notify.
 * `fn` receives the item and the full collection, returns the updated item.
 */
export function mutateItem<T>(
  ops: CollectionOps<T>,
  id: string,
  fn: (item: T, all: Record<string, T>) => T,
): T | null {
  const all = ops.load()
  if (!all[id]) return null
  all[id] = fn(all[id], all)
  ops.save(all)
  if (ops.topic) notify(ops.topic)
  return all[id]
}

/**
 * Load → 404 check → delete → notify.
 * Uses `ops.deleteFn` if provided, otherwise inline `delete` + `save`.
 */
export function deleteItem<T>(
  ops: CollectionOps<T>,
  id: string,
): boolean {
  const all = ops.load()
  if (!all[id]) return false
  if (ops.deleteFn) {
    ops.deleteFn(id)
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
