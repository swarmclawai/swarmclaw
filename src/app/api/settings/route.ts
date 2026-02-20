import { NextResponse } from 'next/server'
import { loadSettings, saveSettings } from '@/lib/server/storage'

const MEMORY_DEPTH_MIN = 0
const MEMORY_DEPTH_MAX = 12
const MEMORY_PER_LOOKUP_MIN = 1
const MEMORY_PER_LOOKUP_MAX = 200
const MEMORY_LINKED_MIN = 0
const MEMORY_LINKED_MAX = 1000

function parseIntSetting(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

export async function GET() {
  return NextResponse.json(loadSettings())
}

export async function PUT(req: Request) {
  const body = await req.json()
  const settings = loadSettings()
  Object.assign(settings, body)

  const nextDepth = parseIntSetting(
    settings.memoryReferenceDepth ?? settings.memoryMaxDepth,
    3,
    MEMORY_DEPTH_MIN,
    MEMORY_DEPTH_MAX,
  )
  const nextPerLookup = parseIntSetting(
    settings.maxMemoriesPerLookup ?? settings.memoryMaxPerLookup,
    20,
    MEMORY_PER_LOOKUP_MIN,
    MEMORY_PER_LOOKUP_MAX,
  )
  const nextLinked = parseIntSetting(
    settings.maxLinkedMemoriesExpanded,
    60,
    MEMORY_LINKED_MIN,
    MEMORY_LINKED_MAX,
  )

  // Keep new and legacy keys synchronized for backward compatibility.
  settings.memoryReferenceDepth = nextDepth
  settings.memoryMaxDepth = nextDepth
  settings.maxMemoriesPerLookup = nextPerLookup
  settings.memoryMaxPerLookup = nextPerLookup
  settings.maxLinkedMemoriesExpanded = nextLinked

  saveSettings(settings)
  return NextResponse.json(settings)
}
