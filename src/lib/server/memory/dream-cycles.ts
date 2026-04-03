import fs from 'fs'
import path from 'path'
import { DATA_DIR } from '@/lib/server/data-dir'
import { hmrSingleton, safeJsonParse } from '@/lib/shared-utils'
import type { DreamCycle } from '@/types'

const DREAM_CYCLES_PATH = path.join(DATA_DIR, 'dream-cycles.json')

const state = hmrSingleton('__dream_cycles__', () => ({
  cycles: null as DreamCycle[] | null,
}))

function ensureLoaded(): DreamCycle[] {
  if (state.cycles !== null) return state.cycles
  try {
    const raw = fs.readFileSync(DREAM_CYCLES_PATH, { encoding: 'utf-8' })
    state.cycles = safeJsonParse<DreamCycle[]>(raw, [])
  } catch {
    state.cycles = []
  }
  return state.cycles
}

function persist(): void {
  fs.mkdirSync(path.dirname(DREAM_CYCLES_PATH), { recursive: true })
  fs.writeFileSync(DREAM_CYCLES_PATH, JSON.stringify(ensureLoaded(), null, 2), { encoding: 'utf-8' })
}

export function saveDreamCycle(cycle: DreamCycle): void {
  const cycles = ensureLoaded()
  const idx = cycles.findIndex((c) => c.id === cycle.id)
  if (idx >= 0) {
    cycles[idx] = cycle
  } else {
    cycles.push(cycle)
  }
  persist()
}

export function listDreamCycles(agentId?: string, limit = 50): DreamCycle[] {
  const cycles = ensureLoaded()
  const filtered = agentId ? cycles.filter((c) => c.agentId === agentId) : [...cycles]
  filtered.sort((a, b) => b.startedAt - a.startedAt)
  return filtered.slice(0, limit)
}

export function getDreamCycle(id: string): DreamCycle | null {
  return ensureLoaded().find((c) => c.id === id) ?? null
}
