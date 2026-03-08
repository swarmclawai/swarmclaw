import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { AppNotification } from '@/types'
import { createNotification } from './create-notification'

describe('createNotification', () => {
  it('coalesces repeated dedupKey events into one notification record', () => {
    const store = new Map<string, AppNotification>()
    const notifyTopics: string[] = []
    const dispatched: string[] = []

    const deps = {
      now: (() => {
        let current = 1_700_000_000_000
        return () => {
          current += 1_000
          return current
        }
      })(),
      save: (id: string, data: AppNotification) => {
        store.set(id, data)
      },
      notifyTopic: (topic: string) => {
        notifyTopics.push(topic)
      },
      dispatch: async (notification: AppNotification) => {
        dispatched.push(notification.id)
      },
      findByDedupKey: (dedupKey: string) => {
        for (const notification of store.values()) {
          if (notification.dedupKey === dedupKey) return notification
        }
        return null
      },
      createId: (() => {
        let seq = 0
        return () => `notif_${++seq}`
      })(),
    }

    const first = createNotification({
      type: 'warning',
      title: 'Provider unreachable',
      message: 'Timeout',
      dedupKey: 'provider-down:test',
    }, deps)

    const second = createNotification({
      type: 'warning',
      title: 'Provider unreachable',
      message: 'Still timing out',
      dedupKey: 'provider-down:test',
    }, deps)

    assert.equal(first.created, true)
    assert.equal(second.created, false)
    assert.equal(store.size, 1)
    assert.equal(second.notification.id, first.notification.id)
    assert.equal(second.notification.message, 'Still timing out')
    assert.equal(second.notification.occurrenceCount, 2)
    assert.equal(second.notification.read, false)
    assert.deepEqual(notifyTopics, ['notifications', 'notifications'])
    assert.deepEqual(dispatched, [first.notification.id])
  })

  it('can keep a notification in-app only without external dispatch', () => {
    const store = new Map<string, AppNotification>()
    const dispatched: string[] = []

    const result = createNotification({
      type: 'warning',
      title: 'SwarmClaw health alert',
      message: 'Connector recovered.',
      dedupKey: 'health-alert:connector-recovered',
      dispatchExternally: false,
    }, {
      now: () => 1_700_000_000_000,
      save: (id: string, data: AppNotification) => {
        store.set(id, data)
      },
      notifyTopic: () => {},
      dispatch: async (notification: AppNotification) => {
        dispatched.push(notification.id)
      },
      findByDedupKey: () => null,
      createId: () => 'notif_health',
    })

    assert.equal(result.created, true)
    assert.equal(store.get('notif_health')?.title, 'SwarmClaw health alert')
    assert.deepEqual(dispatched, [])
  })
})
