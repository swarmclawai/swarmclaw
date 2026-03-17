import { loadSettings } from '@/lib/server/settings/settings-repository'
import type { AppNotification } from '@/types'
import { errorMessage } from '@/lib/shared-utils'
import { log } from '@/lib/server/logger'

const TAG = 'alert-dispatch'

/** In-memory rate limiter: dedupKey → last dispatch timestamp */
const recentDispatches = new Map<string, number>()
const DEDUP_WINDOW_MS = 60_000

export async function dispatchAlert(notification: AppNotification): Promise<void> {
  const settings = loadSettings()
  const url = typeof settings.alertWebhookUrl === 'string' ? settings.alertWebhookUrl.trim() : ''
  if (!url) return

  const allowedEvents: string[] = Array.isArray(settings.alertWebhookEvents)
    ? settings.alertWebhookEvents
    : ['error']
  if (!allowedEvents.includes(notification.type)) return

  // Rate limit by dedupKey (or notification id as fallback)
  const dedupKey = notification.dedupKey || notification.id
  const now = Date.now()
  const lastSent = recentDispatches.get(dedupKey)
  if (lastSent && now - lastSent < DEDUP_WINDOW_MS) return
  recentDispatches.set(dedupKey, now)

  // Prune stale entries on every write to bound growth
  for (const [key, ts] of recentDispatches) {
    if (now - ts > DEDUP_WINDOW_MS) recentDispatches.delete(key)
  }

  const webhookType = settings.alertWebhookType || 'custom'
  let body: string

  if (webhookType === 'discord') {
    body = JSON.stringify({
      content: `⚠️ **${notification.title}**${notification.message ? `\n${notification.message}` : ''}`,
    })
  } else if (webhookType === 'slack') {
    body = JSON.stringify({
      text: `⚠️ *${notification.title}*${notification.message ? `\n${notification.message}` : ''}`,
    })
  } else {
    body = JSON.stringify({
      type: notification.type,
      title: notification.title,
      message: notification.message || null,
      entityType: notification.entityType || null,
      entityId: notification.entityId || null,
      timestamp: notification.createdAt,
    })
  }

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(5000),
    })
  } catch (err: unknown) {
    log.warn(TAG, 'Webhook delivery failed:', errorMessage(err))
  }
}
