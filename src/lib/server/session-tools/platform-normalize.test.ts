import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizePlatformActionArgs } from './platform'

describe('normalizePlatformActionArgs', () => {
  it('packs top-level create fields into data', () => {
    const out = normalizePlatformActionArgs({
      resource: 'tasks',
      action: 'create',
      title: 'Write docs',
      agentId: 'default',
    })

    assert.equal(out.resource, 'tasks')
    assert.equal(out.action, 'create')
    assert.deepEqual(JSON.parse(String(out.data)), {
      title: 'Write docs',
      agentId: 'default',
    })
  })

  it('merges object data with top-level overrides', () => {
    const out = normalizePlatformActionArgs({
      resource: 'tasks',
      action: 'create',
      data: { title: 'Old title', agentId: 'coder' },
      title: 'New title',
    })

    assert.deepEqual(JSON.parse(String(out.data)), {
      title: 'New title',
      agentId: 'coder',
    })
  })

  it('normalizes legacy resources envelope with parameters payload', () => {
    const out = normalizePlatformActionArgs({
      input: JSON.stringify({
        resources: [
          {
            resource: 'tasks',
            action: 'create',
            parameters: {
              title: 'Legacy task',
              assigned_agent: 'default',
            },
          },
        ],
      }),
    })

    assert.equal(out.resource, 'tasks')
    assert.equal(out.action, 'create')
    assert.deepEqual(JSON.parse(String(out.data)), {
      title: 'Legacy task',
      assigned_agent: 'default',
    })
  })

  it('normalizes singular resource names and resource payload objects', () => {
    const out = normalizePlatformActionArgs({
      input: JSON.stringify({
        resource: 'task',
        action: 'create',
        task: {
          title: 'Legacy singular task',
          assigned_to: 'default',
        },
      }),
    })

    assert.equal(out.resource, 'tasks')
    assert.equal(out.action, 'create')
    assert.deepEqual(JSON.parse(String(out.data)), {
      title: 'Legacy singular task',
      assigned_to: 'default',
    })
  })

  it('normalizes legacy backlog task resource names to tasks', () => {
    const out = normalizePlatformActionArgs({
      input: JSON.stringify({
        resource: 'backlog_task',
        action: 'create',
        backlog_task: {
          title: 'Legacy backlog task',
          description: 'Keep the intended task payload',
        },
      }),
    })

    assert.equal(out.resource, 'tasks')
    assert.equal(out.action, 'create')
    assert.deepEqual(JSON.parse(String(out.data)), {
      title: 'Legacy backlog task',
      description: 'Keep the intended task payload',
    })
  })

  it('normalizes resources entries that use type instead of resource', () => {
    const out = normalizePlatformActionArgs({
      input: JSON.stringify({
        action: 'create',
        resources: [
          {
            type: 'task',
            parameters: {
              title: 'Typed task resource',
              description: 'Created through a typed resources envelope',
            },
          },
        ],
      }),
    })

    assert.equal(out.resource, 'tasks')
    assert.equal(out.action, 'create')
    assert.deepEqual(JSON.parse(String(out.data)), {
      title: 'Typed task resource',
      description: 'Created through a typed resources envelope',
    })
  })

  it('infers schedules resource from create_schedule style actions', () => {
    const out = normalizePlatformActionArgs({
      input: JSON.stringify({
        action: 'create_schedule',
        data: {
          name: 'Surgery check-in',
          scheduleType: 'once',
        },
      }),
    })

    assert.equal(out.resource, 'schedules')
    assert.equal(out.action, 'create')
    assert.deepEqual(JSON.parse(String(out.data)), {
      name: 'Surgery check-in',
      scheduleType: 'once',
    })
  })
})
