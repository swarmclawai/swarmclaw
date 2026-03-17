import { perf } from '@/lib/server/runtime/perf'

export interface RecordRepository<
  T,
  ListOptions = void,
  UpsertValue = T | Record<string, unknown>,
> {
  get(id: string, options?: ListOptions): T | null
  getMany(ids: string[], options?: ListOptions): Record<string, T>
  list(options?: ListOptions): Record<string, T>
  upsert(id: string, value: UpsertValue): void
  upsertMany(entries: Array<[string, UpsertValue]>): void
  patch(id: string, updater: (current: T | null) => T | null, options?: ListOptions): T | null
  replace(data: Record<string, UpsertValue>): void
  delete(id: string): void
}

interface RecordRepositoryOps<
  T,
  ListOptions = void,
  UpsertValue = T | Record<string, unknown>,
> {
  get(id: string, options?: ListOptions): T | null
  list(options?: ListOptions): Record<string, T>
  upsert(id: string, value: UpsertValue): void
  upsertMany?: (entries: Array<[string, UpsertValue]>) => void
  patch?: (id: string, updater: (current: T | null) => T | null) => T | null
  replace?: (data: Record<string, UpsertValue>) => void
  delete?: (id: string) => void
}

export interface SingletonRepository<
  T,
  SaveValue = T | Record<string, unknown>,
> {
  get(): T
  save(value: SaveValue): void
  patch(updater: (current: T) => SaveValue): T
}

interface SingletonRepositoryOps<
  T,
  SaveValue = T | Record<string, unknown>,
> {
  get(): T
  save(value: SaveValue): void
}

function uniqueIds(ids: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    const normalized = typeof id === 'string' ? id.trim() : ''
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}

export function createRecordRepository<
  T,
  ListOptions = void,
  UpsertValue = T | Record<string, unknown>,
>(
  name: string,
  ops: RecordRepositoryOps<T, ListOptions, UpsertValue>,
): RecordRepository<T, ListOptions, UpsertValue> {
  return {
    get(id, options) {
      return perf.measureSync('repository', `${name}.get`, () => ops.get(id, options), { id })
    },
    getMany(ids, options) {
      return perf.measureSync('repository', `${name}.getMany`, () => {
        const result: Record<string, T> = {}
        for (const id of uniqueIds(ids)) {
          const item = ops.get(id, options)
          if (item) result[id] = item
        }
        return result
      }, { count: ids.length })
    },
    list(options) {
      return perf.measureSync('repository', `${name}.list`, () => ops.list(options))
    },
    upsert(id, value) {
      perf.measureSync('repository', `${name}.upsert`, () => ops.upsert(id, value), { id })
    },
    upsertMany(entries) {
      perf.measureSync('repository', `${name}.upsertMany`, () => {
        if (ops.upsertMany) {
          ops.upsertMany(entries)
          return
        }
        for (const [id, value] of entries) ops.upsert(id, value)
      }, { count: entries.length })
    },
    patch(id, updater, options) {
      return perf.measureSync('repository', `${name}.patch`, () => {
        if (ops.patch) return ops.patch(id, updater)
        const current = ops.get(id, options)
        const next = updater(current)
        if (next === null) {
          if (!ops.delete) return null
          ops.delete(id)
          return null
        }
        ops.upsert(id, next as UpsertValue)
        return next
      }, { id })
    },
    replace(data) {
      perf.measureSync('repository', `${name}.replace`, () => {
        if (ops.replace) {
          ops.replace(data)
          return
        }
        const entries = Object.entries(data)
        if (ops.upsertMany) ops.upsertMany(entries)
        else for (const [id, value] of entries) ops.upsert(id, value)
      }, { count: Object.keys(data).length })
    },
    delete(id) {
      perf.measureSync('repository', `${name}.delete`, () => {
        if (!ops.delete) return
        ops.delete(id)
      }, { id })
    },
  }
}

export function createSingletonRepository<
  T,
  SaveValue = T | Record<string, unknown>,
>(
  name: string,
  ops: SingletonRepositoryOps<T, SaveValue>,
): SingletonRepository<T, SaveValue> {
  return {
    get() {
      return perf.measureSync('repository', `${name}.get`, () => ops.get())
    },
    save(value) {
      perf.measureSync('repository', `${name}.save`, () => ops.save(value))
    },
    patch(updater) {
      return perf.measureSync('repository', `${name}.patch`, () => {
        const next = updater(ops.get())
        ops.save(next)
        return ops.get()
      })
    },
  }
}
