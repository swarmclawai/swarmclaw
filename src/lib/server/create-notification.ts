import { genId } from '@/lib/id'
import { upsertNotificationRecord } from '@/lib/notifications/notification-utils'
import { findNotificationByDedupKey, saveNotification } from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'
import { dispatchAlert } from '@/lib/server/runtime/alert-dispatch'
import type { AppNotification } from '@/types'

/**
 * Create or refresh a notification, then push a WS invalidation.
 * Repeated events with the same `dedupKey` update one notification record
 * instead of creating a new row every time.
 */
export function createNotification(opts: {
  type: AppNotification['type']
  title: string
  message?: string
  actionLabel?: string
  actionUrl?: string
  entityType?: string
  entityId?: string
  dedupKey?: string
  dispatchExternally?: boolean
}, deps: {
  now?: () => number
  save?: (id: string, data: AppNotification) => void
  notifyTopic?: (topic: string) => void
  dispatch?: (notification: AppNotification) => Promise<unknown>
  findByDedupKey?: (dedupKey: string) => AppNotification | null
  createId?: () => string
} = {}): { notification: AppNotification; created: boolean } {
  const now = deps.now?.() ?? Date.now()
  const save = deps.save ?? saveNotification
  const emit = deps.notifyTopic ?? notify
  const sendAlert = deps.dispatch ?? dispatchAlert
  const existing = opts.dedupKey
    ? (deps.findByDedupKey ?? findNotificationByDedupKey)(opts.dedupKey)
    : null

  const { notification, created } = upsertNotificationRecord(existing, opts, {
    now,
    createId: deps.createId ?? (() => genId()),
  })

  save(notification.id, notification)
  emit('notifications')
  if (created && opts.dispatchExternally !== false) {
    sendAlert(notification).catch(() => {})
  }
  return { notification, created }
}
