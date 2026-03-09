import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..')

function runWithTempDataDir(script: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-schedule-tool-'))
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATA_DIR: path.join(tempDir, 'data'),
        WORKSPACE_DIR: path.join(tempDir, 'workspace'),
      },
      encoding: 'utf-8',
    })
    assert.equal(result.status, 0, result.stderr || result.stdout || 'subprocess failed')
    const lines = (result.stdout || '')
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    const jsonLine = [...lines].reverse().find((line) => line.startsWith('{'))
    return JSON.parse(jsonLine || '{}')
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

describe('manage_schedules tool', () => {
  it('defaults schedules to the current agent and derives a runnable taskPrompt from run_script payloads', () => {
    const output = runWithTempDataDir(`
      import fs from 'node:fs'
      import path from 'node:path'
      const storageMod = await import('./src/lib/server/storage')
      const crudMod = await import('./src/lib/server/session-tools/crud')
      const storage = storageMod.default || storageMod
      const crud = crudMod.default || crudMod

      const now = Date.now()
      storage.saveAgents({
        default: {
          id: 'default',
          name: 'Molly',
          description: '',
          systemPrompt: '',
          provider: 'openai',
          model: 'gpt-test',
          createdAt: now,
          updatedAt: now,
        },
      })

      const cwd = process.env.WORKSPACE_DIR
      fs.mkdirSync(path.join(cwd, 'weather_workspace'), { recursive: true })
      fs.writeFileSync(path.join(cwd, 'weather_workspace', 'weather_fetch.py'), 'print("weather")\\n')

      const tools = crud.buildCrudTools({
        cwd,
        ctx: { sessionId: 'session-1', agentId: 'default', platformAssignScope: 'self' },
        hasPlugin: (name) => name === 'manage_schedules',
      })
      const tool = tools.find((entry) => entry.name === 'manage_schedules')
      const raw = await tool.invoke({
        action: 'create',
        data: JSON.stringify({
          name: 'Daily Weather Update',
          scheduleType: 'interval',
          intervalMs: 60000,
          action: 'run_script',
          path: 'weather_workspace/weather_fetch.py',
        }),
      })

      const schedule = Object.values(storage.loadSchedules())[0]
      console.log(JSON.stringify({
        raw,
        schedule,
      }))
    `)

    assert.equal(output.schedule.agentId, 'default')
    assert.equal(output.schedule.path, 'weather_workspace/weather_fetch.py')
    assert.match(output.schedule.taskPrompt, /weather_workspace\/weather_fetch\.py/)
    assert.equal(output.schedule.status, 'active')
    assert.equal(typeof output.schedule.nextRunAt, 'number')
  })

  it('stores the current connector recipient on new schedules created from a connector session', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const crudMod = await import('./src/lib/server/session-tools/crud')
      const storage = storageMod.default || storageMod
      const crud = crudMod.default || crudMod

      const now = Date.now()
      storage.saveAgents({
        default: {
          id: 'default',
          name: 'Molly',
          description: '',
          systemPrompt: '',
          provider: 'openai',
          model: 'gpt-test',
          createdAt: now,
          updatedAt: now,
        },
      })
      storage.saveSessions({
        'session-wa': {
          id: 'session-wa',
          name: 'connector:whatsapp:gran',
          cwd: process.env.WORKSPACE_DIR,
          user: 'connector',
          provider: 'openai',
          model: 'gpt-test',
          credentialId: null,
          apiEndpoint: null,
          claudeSessionId: null,
          codexThreadId: null,
          opencodeSessionId: null,
          delegateResumeIds: { claudeCode: null, codex: null, opencode: null, gemini: null },
          messages: [],
          createdAt: now,
          lastActiveAt: now,
          sessionType: 'human',
          agentId: 'default',
          plugins: [],
          connectorContext: {
            connectorId: 'conn-wa',
            platform: 'whatsapp',
            channelId: '447700900123@s.whatsapp.net',
            senderId: '447700900123@s.whatsapp.net',
            senderName: 'Wayde',
            threadId: 'thread-7',
          },
        },
      })

      const tools = crud.buildCrudTools({
        cwd: process.env.WORKSPACE_DIR,
        ctx: { sessionId: 'session-wa', agentId: 'default', platformAssignScope: 'self' },
        hasPlugin: (name) => name === 'manage_schedules',
      })
      const tool = tools.find((entry) => entry.name === 'manage_schedules')
      await tool.invoke({
        action: 'create',
        data: JSON.stringify({
          name: 'Birthday Reminder',
          scheduleType: 'once',
          runAt: now + 60_000,
          taskPrompt: 'Wish me a happy birthday tomorrow.',
        }),
      })

      const schedule = Object.values(storage.loadSchedules())[0]
      console.log(JSON.stringify({ schedule }))
    `)

    assert.equal(output.schedule.followupConnectorId, 'conn-wa')
    assert.equal(output.schedule.followupChannelId, '447700900123@s.whatsapp.net')
    assert.equal(output.schedule.followupThreadId, 'thread-7')
    assert.equal(output.schedule.followupSenderName, 'Wayde')
  })

  it('rejects schedules whose referenced script path does not exist', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const crudMod = await import('./src/lib/server/session-tools/crud')
      const storage = storageMod.default || storageMod
      const crud = crudMod.default || crudMod

      const now = Date.now()
      storage.saveAgents({
        default: {
          id: 'default',
          name: 'Molly',
          description: '',
          systemPrompt: '',
          provider: 'openai',
          model: 'gpt-test',
          createdAt: now,
          updatedAt: now,
        },
      })

      const tools = crud.buildCrudTools({
        cwd: process.env.WORKSPACE_DIR,
        ctx: { sessionId: 'session-2', agentId: 'default', platformAssignScope: 'self' },
        hasPlugin: (name) => name === 'manage_schedules',
      })
      const tool = tools.find((entry) => entry.name === 'manage_schedules')
      const raw = await tool.invoke({
        action: 'create',
        data: JSON.stringify({
          name: 'Broken Weather Update',
          scheduleType: 'interval',
          intervalMs: 60000,
          action: 'run_script',
          path: 'weather_workspace/missing.py',
        }),
      })

      console.log(JSON.stringify({ raw }))
    `)

    assert.match(String(output.raw), /schedule path not found: weather_workspace\/missing\.py/i)
  })

  it('reuses a same-session recurring reminder instead of creating a near-duplicate', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const crudMod = await import('./src/lib/server/session-tools/crud')
      const storage = storageMod.default || storageMod
      const crud = crudMod.default || crudMod

      const now = Date.now()
      storage.saveAgents({
        default: {
          id: 'default',
          name: 'Molly',
          description: '',
          systemPrompt: '',
          provider: 'openai',
          model: 'gpt-test',
          createdAt: now,
          updatedAt: now,
        },
      })

      const tools = crud.buildCrudTools({
        cwd: process.env.WORKSPACE_DIR,
        ctx: { sessionId: 'session-reminder', agentId: 'default', platformAssignScope: 'self' },
        hasPlugin: (name) => name === 'manage_schedules',
      })
      const tool = tools.find((entry) => entry.name === 'manage_schedules')
      await tool.invoke({
        action: 'create',
        data: JSON.stringify({
          name: 'Daily Iran Update',
          agentId: 'default',
          taskPrompt: 'Daily check for updates on US-Iran tensions',
          scheduleType: 'cron',
          cron: '0 9 * * *',
        }),
      })

      const raw = await tool.invoke({
        action: 'create',
        data: JSON.stringify({
          name: 'Iran Reminder',
          agentId: 'default',
          taskPrompt: 'Periodic update check for US-Iran tensions',
          scheduleType: 'interval',
          intervalMs: 86400000,
        }),
      })

      console.log(JSON.stringify({
        raw,
        schedules: Object.values(storage.loadSchedules()),
      }))
    `)

    const parsed = JSON.parse(String(output.raw))
    assert.equal(parsed.deduplicated, true)
    assert.equal(output.schedules.length, 1)
  })

  it('pauses matching duplicate schedules together when an agent stops a reminder', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const crudMod = await import('./src/lib/server/session-tools/crud')
      const storage = storageMod.default || storageMod
      const crud = crudMod.default || crudMod

      const now = Date.now()
      storage.saveAgents({
        default: {
          id: 'default',
          name: 'Molly',
          description: '',
          systemPrompt: '',
          provider: 'openai',
          model: 'gpt-test',
          createdAt: now,
          updatedAt: now,
        },
      })

      storage.saveSchedules({
        one: {
          id: 'one',
          name: 'Iran Update',
          agentId: 'default',
          taskPrompt: 'Daily check for updates on US-Iran tensions',
          scheduleType: 'cron',
          cron: '0 9 * * *',
          status: 'active',
          createdByAgentId: 'default',
          createdInSessionId: 'session-reminder',
          createdAt: now,
          updatedAt: now,
        },
        two: {
          id: 'two',
          name: 'Iran Reminder',
          agentId: 'default',
          taskPrompt: 'Periodic update check for US-Iran tensions',
          scheduleType: 'interval',
          intervalMs: 86400000,
          status: 'active',
          createdByAgentId: 'default',
          createdInSessionId: 'session-reminder',
          createdAt: now + 1,
          updatedAt: now + 1,
        },
      })

      const tools = crud.buildCrudTools({
        cwd: process.env.WORKSPACE_DIR,
        ctx: { sessionId: 'session-reminder', agentId: 'default', platformAssignScope: 'self' },
        hasPlugin: (name) => name === 'manage_schedules',
      })
      const tool = tools.find((entry) => entry.name === 'manage_schedules')
      const raw = await tool.invoke({
        action: 'update',
        id: 'one',
        data: JSON.stringify({ status: 'paused' }),
      })

      console.log(JSON.stringify({
        raw,
        schedules: storage.loadSchedules(),
      }))
    `)

    const parsed = JSON.parse(String(output.raw))
    assert.deepEqual(new Set(parsed.affectedScheduleIds), new Set(['one', 'two']))
    assert.equal(output.schedules.one.status, 'paused')
    assert.equal(output.schedules.two.status, 'paused')
  })

  it('deletes matching duplicate schedules together when an agent removes a reminder cluster', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const crudMod = await import('./src/lib/server/session-tools/crud')
      const storage = storageMod.default || storageMod
      const crud = crudMod.default || crudMod

      const now = Date.now()
      storage.saveAgents({
        default: {
          id: 'default',
          name: 'Molly',
          description: '',
          systemPrompt: '',
          provider: 'openai',
          model: 'gpt-test',
          createdAt: now,
          updatedAt: now,
        },
      })

      storage.saveSchedules({
        one: {
          id: 'one',
          name: 'Iran Update',
          agentId: 'default',
          taskPrompt: 'Daily check for updates on US-Iran tensions',
          scheduleType: 'cron',
          cron: '0 9 * * *',
          status: 'active',
          createdByAgentId: 'default',
          createdInSessionId: 'session-reminder',
          createdAt: now,
          updatedAt: now,
        },
        two: {
          id: 'two',
          name: 'Iran Reminder',
          agentId: 'default',
          taskPrompt: 'Periodic update check for US-Iran tensions',
          scheduleType: 'interval',
          intervalMs: 86400000,
          status: 'active',
          createdByAgentId: 'default',
          createdInSessionId: 'session-reminder',
          createdAt: now + 1,
          updatedAt: now + 1,
        },
      })

      const tools = crud.buildCrudTools({
        cwd: process.env.WORKSPACE_DIR,
        ctx: { sessionId: 'session-reminder', agentId: 'default', platformAssignScope: 'self' },
        hasPlugin: (name) => name === 'manage_schedules',
      })
      const tool = tools.find((entry) => entry.name === 'manage_schedules')
      const raw = await tool.invoke({
        action: 'delete',
        id: 'one',
      })

      console.log(JSON.stringify({
        raw,
        schedules: storage.loadSchedules(),
      }))
    `)

    const parsed = JSON.parse(String(output.raw))
    assert.deepEqual(new Set(parsed.deletedIds), new Set(['one', 'two']))
    assert.deepEqual(output.schedules, {})
  })
})
