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
      const storageMod = await import('./src/lib/server/storage.ts')
      const crudMod = await import('./src/lib/server/session-tools/crud.ts')
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

  it('rejects schedules whose referenced script path does not exist', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage.ts')
      const crudMod = await import('./src/lib/server/session-tools/crud.ts')
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
})
