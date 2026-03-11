import fs from 'node:fs'
import path from 'node:path'
import { hmrSingleton } from '@/lib/shared-utils'
import {
  SANDBOX_BROWSER_REGISTRY_PATH,
  SANDBOX_REGISTRY_PATH,
} from './constants'

export interface SandboxRegistryEntry {
  containerName: string
  scopeKey: string
  createdAtMs: number
  lastUsedAtMs: number
  image: string
  configHash?: string
}

export interface SandboxBrowserRegistryEntry extends SandboxRegistryEntry {
  cdpPort: number
  noVncPort?: number
}

type RegistryFile<T> = {
  entries: T[]
}

const writeQueues = hmrSingleton('__swarmclaw_sandbox_registry_writes__', () => new Map<string, Promise<void>>())

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
}

function readRegistryFile<T>(filePath: string): RegistryFile<T> {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as RegistryFile<T> | null
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
      return { entries: [] }
    }
    return parsed
  } catch {
    return { entries: [] }
  }
}

function writeRegistryFile<T>(filePath: string, next: RegistryFile<T>): void {
  ensureParentDir(filePath)
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8')
  fs.renameSync(tmpPath, filePath)
}

async function withRegistryMutation<T extends { containerName: string }>(
  filePath: string,
  mutate: (entries: T[]) => T[],
): Promise<void> {
  const previous = writeQueues.get(filePath) || Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const current = readRegistryFile<T>(filePath)
      writeRegistryFile(filePath, { entries: mutate(current.entries) })
    })
  writeQueues.set(filePath, next)
  await next
}

function upsertEntry<T extends SandboxRegistryEntry>(entries: T[], entry: T): T[] {
  const existing = entries.find((candidate) => candidate.containerName === entry.containerName)
  return [
    ...entries.filter((candidate) => candidate.containerName !== entry.containerName),
    {
      ...entry,
      createdAtMs: existing?.createdAtMs ?? entry.createdAtMs,
    },
  ]
}

export async function readSandboxRegistry(): Promise<RegistryFile<SandboxRegistryEntry>> {
  return readRegistryFile<SandboxRegistryEntry>(SANDBOX_REGISTRY_PATH)
}

export async function upsertSandboxRegistryEntry(entry: SandboxRegistryEntry): Promise<void> {
  await withRegistryMutation<SandboxRegistryEntry>(SANDBOX_REGISTRY_PATH, (entries) => upsertEntry(entries, entry))
}

export async function removeSandboxRegistryEntry(containerName: string): Promise<void> {
  await withRegistryMutation<SandboxRegistryEntry>(
    SANDBOX_REGISTRY_PATH,
    (entries) => entries.filter((entry) => entry.containerName !== containerName),
  )
}

export async function readSandboxBrowserRegistry(): Promise<RegistryFile<SandboxBrowserRegistryEntry>> {
  return readRegistryFile<SandboxBrowserRegistryEntry>(SANDBOX_BROWSER_REGISTRY_PATH)
}

export async function upsertSandboxBrowserRegistryEntry(entry: SandboxBrowserRegistryEntry): Promise<void> {
  await withRegistryMutation<SandboxBrowserRegistryEntry>(
    SANDBOX_BROWSER_REGISTRY_PATH,
    (entries) => upsertEntry(entries, entry),
  )
}

export async function removeSandboxBrowserRegistryEntry(containerName: string): Promise<void> {
  await withRegistryMutation<SandboxBrowserRegistryEntry>(
    SANDBOX_BROWSER_REGISTRY_PATH,
    (entries) => entries.filter((entry) => entry.containerName !== containerName),
  )
}
