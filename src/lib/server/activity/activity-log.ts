import { loadActivity as loadStoredActivity, logActivity as writeActivityLog } from '@/lib/server/storage'
import { perf } from '@/lib/server/runtime/perf'

export function loadActivity() {
  return perf.measureSync('repository', 'activity.list', () => loadStoredActivity())
}

export function logActivity(entry: {
  entityType: string
  entityId: string
  action: string
  actor: string
  actorId?: string
  summary: string
  detail?: Record<string, unknown>
}) {
  perf.measureSync('repository', 'activity.log', () => writeActivityLog(entry), {
    entityType: entry.entityType,
    action: entry.action,
  })
}
