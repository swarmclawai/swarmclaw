import type { UsageRecord } from '@/types'

import {
  appendUsage as appendStoredUsage,
  getUsageSpendSince as getStoredUsageSpendSince,
  loadUsage as loadStoredUsage,
  pruneOldUsage as pruneStoredUsage,
  saveUsage as saveStoredUsage,
} from '@/lib/server/storage'
import { perf } from '@/lib/server/runtime/perf'

export function loadUsage(): Record<string, UsageRecord[]> {
  return perf.measureSync('repository', 'usage.list', () => loadStoredUsage())
}

export function saveUsage(data: Record<string, UsageRecord[]>): void {
  perf.measureSync('repository', 'usage.replace', () => saveStoredUsage(data), { count: Object.keys(data).length })
}

export function appendUsage(sessionId: string, record: unknown): void {
  perf.measureSync('repository', 'usage.append', () => appendStoredUsage(sessionId, record), { sessionId })
}

export function getUsageSpendSince(minTimestamp: number): number {
  return perf.measureSync('repository', 'usage.spendSince', () => getStoredUsageSpendSince(minTimestamp), { minTimestamp })
}

export function pruneOldUsage(maxAgeMs: number): number {
  return perf.measureSync('repository', 'usage.prune', () => pruneStoredUsage(maxAgeMs), { maxAgeMs })
}
