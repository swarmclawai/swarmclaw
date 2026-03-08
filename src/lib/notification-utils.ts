import type { AppNotification } from '@/types'

export type NotificationDraft = Pick<
  AppNotification,
  'type' | 'title' | 'message' | 'actionLabel' | 'actionUrl' | 'entityType' | 'entityId' | 'dedupKey'
>

export function getNotificationActivityAt(
  notification: Pick<AppNotification, 'createdAt' | 'updatedAt'>,
): number {
  return typeof notification.updatedAt === 'number' ? notification.updatedAt : notification.createdAt
}

export function getNotificationOccurrenceCount(
  notification: Pick<AppNotification, 'occurrenceCount'>,
): number {
  return typeof notification.occurrenceCount === 'number' && notification.occurrenceCount > 1
    ? notification.occurrenceCount
    : 1
}

export function upsertNotificationRecord(
  existing: AppNotification | null | undefined,
  draft: NotificationDraft,
  options: {
    now: number
    createId: () => string
  },
): { notification: AppNotification; created: boolean } {
  if (existing) {
    return {
      created: false,
      notification: {
        ...existing,
        type: draft.type,
        title: draft.title,
        message: draft.message,
        actionLabel: draft.actionLabel,
        actionUrl: draft.actionUrl,
        entityType: draft.entityType,
        entityId: draft.entityId,
        dedupKey: draft.dedupKey,
        read: false,
        updatedAt: options.now,
        occurrenceCount: getNotificationOccurrenceCount(existing) + 1,
      },
    }
  }

  return {
    created: true,
    notification: {
      id: options.createId(),
      type: draft.type,
      title: draft.title,
      message: draft.message,
      actionLabel: draft.actionLabel,
      actionUrl: draft.actionUrl,
      entityType: draft.entityType,
      entityId: draft.entityId,
      dedupKey: draft.dedupKey,
      read: false,
      createdAt: options.now,
      updatedAt: options.now,
      occurrenceCount: 1,
    },
  }
}
