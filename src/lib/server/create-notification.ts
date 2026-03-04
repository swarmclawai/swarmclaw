import { genId } from '@/lib/id'
import { saveNotification, hasUnreadNotificationWithKey } from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'
import { dispatchAlert } from '@/lib/server/alert-dispatch'
import type { AppNotification } from '@/types'

/**
 * Create and persist a notification, then push a WS invalidation.
 * If `dedupKey` is provided and an unread notification with the same key
 * already exists, returns `null` (no insert, no WS push).
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
}): AppNotification | null {
  if (opts.dedupKey && hasUnreadNotificationWithKey(opts.dedupKey)) {
    return null
  }

  const id = genId()
  const notification: AppNotification = {
    id,
    type: opts.type,
    title: opts.title,
    message: opts.message,
    actionLabel: opts.actionLabel,
    actionUrl: opts.actionUrl,
    entityType: opts.entityType,
    entityId: opts.entityId,
    dedupKey: opts.dedupKey,
    read: false,
    createdAt: Date.now(),
  }
  saveNotification(id, notification)
  notify('notifications')
  dispatchAlert(notification).catch(() => {})
  return notification
}
