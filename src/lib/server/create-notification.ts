import { genId } from '@/lib/id'
import { saveNotification } from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'
import type { AppNotification } from '@/types'

/**
 * Create and persist a notification, then push a WS invalidation.
 */
export function createNotification(opts: {
  type: AppNotification['type']
  title: string
  message?: string
  entityType?: string
  entityId?: string
}) {
  const id = genId()
  const notification: AppNotification = {
    id,
    type: opts.type,
    title: opts.title,
    message: opts.message,
    entityType: opts.entityType,
    entityId: opts.entityId,
    read: false,
    createdAt: Date.now(),
  }
  saveNotification(id, notification)
  notify('notifications')
  return notification
}
