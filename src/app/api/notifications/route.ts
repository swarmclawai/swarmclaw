import { NextResponse } from 'next/server'
import { getNotificationActivityAt } from '@/lib/notification-utils'
import { createNotification } from '@/lib/server/create-notification'
import { loadNotifications, deleteNotification } from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'
import type { AppNotification } from '@/types'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const unreadOnly = searchParams.get('unreadOnly') === 'true'
  const limit = Math.min(200, Math.max(1, Number(searchParams.get('limit')) || 100))

  const all = loadNotifications()
  let entries = Object.values(all) as AppNotification[]

  // Approval requests now have a dedicated Approvals view/badge; keep notifications focused on ops/events.
  entries = entries.filter((e) => e.entityType !== 'approval')

  if (unreadOnly) {
    entries = entries.filter((e) => !e.read)
  }

  entries.sort((a, b) => getNotificationActivityAt(b) - getNotificationActivityAt(a))
  entries = entries.slice(0, limit)

  return NextResponse.json(entries)
}

export async function POST(req: Request) {
  const body = (await req.json()) as Record<string, unknown>
  const actionLabel = typeof body.actionLabel === 'string' ? body.actionLabel : undefined
  const actionUrl = typeof body.actionUrl === 'string' ? body.actionUrl : undefined
  const dedupKey = typeof body.dedupKey === 'string' && body.dedupKey.trim()
    ? body.dedupKey.trim()
    : undefined
  const { notification, created } = createNotification({
    type: (['info', 'success', 'warning', 'error'].includes(body.type as string) ? body.type : 'info') as AppNotification['type'],
    title: typeof body.title === 'string' ? body.title : 'Notification',
    message: typeof body.message === 'string' ? body.message : undefined,
    actionLabel,
    actionUrl,
    entityType: typeof body.entityType === 'string' ? body.entityType : undefined,
    entityId: typeof body.entityId === 'string' ? body.entityId : undefined,
    dedupKey,
  })

  return NextResponse.json(notification, { status: created ? 201 : 200 })
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url)
  const specificId = searchParams.get('id')

  if (specificId) {
    deleteNotification(specificId)
  } else {
    // Clear all read notifications
    const all = loadNotifications()
    for (const raw of Object.values(all)) {
      const entry = raw as AppNotification
      if (entry.read) {
        deleteNotification(entry.id)
      }
    }
  }

  notify('notifications')
  return NextResponse.json({ ok: true })
}
