import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  getNotificationActivityAt,
  getNotificationOccurrenceCount,
  upsertNotificationRecord,
} from './notification-utils'

describe('notification utils', () => {
  it('creates fresh notifications with a count and activity timestamp', () => {
    const { created, notification } = upsertNotificationRecord(
      null,
      {
        type: 'info',
        title: 'Provider unreachable',
        message: 'Gateway timeout',
        dedupKey: 'provider-down:test',
      },
      {
        now: 1_700_000_000_000,
        createId: () => 'notif_1',
      },
    )

    assert.equal(created, true)
    assert.equal(notification.id, 'notif_1')
    assert.equal(notification.read, false)
    assert.equal(notification.createdAt, 1_700_000_000_000)
    assert.equal(notification.updatedAt, 1_700_000_000_000)
    assert.equal(notification.occurrenceCount, 1)
  })

  it('refreshes an existing notification instead of duplicating it', () => {
    const { created, notification } = upsertNotificationRecord(
      {
        id: 'notif_existing',
        type: 'warning',
        title: 'Provider unreachable',
        message: 'Old failure',
        dedupKey: 'provider-down:test',
        read: true,
        createdAt: 1_700_000_000_000,
      },
      {
        type: 'warning',
        title: 'Provider unreachable',
        message: 'Still down',
        dedupKey: 'provider-down:test',
      },
      {
        now: 1_700_000_123_000,
        createId: () => 'unused',
      },
    )

    assert.equal(created, false)
    assert.equal(notification.id, 'notif_existing')
    assert.equal(notification.read, false)
    assert.equal(notification.createdAt, 1_700_000_000_000)
    assert.equal(notification.updatedAt, 1_700_000_123_000)
    assert.equal(notification.occurrenceCount, 2)
    assert.equal(notification.message, 'Still down')
  })

  it('prefers updatedAt when sorting and formatting activity', () => {
    assert.equal(getNotificationActivityAt({ createdAt: 100, updatedAt: 250 }), 250)
    assert.equal(getNotificationActivityAt({ createdAt: 100 }), 100)
    assert.equal(getNotificationOccurrenceCount({ occurrenceCount: 4 }), 4)
    assert.equal(getNotificationOccurrenceCount({ occurrenceCount: 0 }), 1)
  })
})
