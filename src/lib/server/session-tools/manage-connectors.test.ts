import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..')

function runWithTempDataDir(script: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-connectors-tool-'))
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

describe('manage_connectors tool', () => {
  it('drops transient outbound-send args on create', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const crudMod = await import('./src/lib/server/session-tools/crud')
      const storage = storageMod.default || storageMod
      const crud = crudMod.default || crudMod

      const tools = crud.buildCrudTools({
        cwd: process.env.WORKSPACE_DIR,
        ctx: { sessionId: 'session-1', agentId: 'agent-1', platformAssignScope: 'all' },
        hasPlugin: (name) => name === 'manage_connectors',
      })
      const tool = tools.find((entry) => entry.name === 'manage_connectors')
      await tool.invoke({
        action: 'create',
        data: JSON.stringify({
          name: 'Main WhatsApp',
          platform: 'whatsapp',
          agentId: 'agent-1',
          enabled: true,
          action: 'send_voice_note',
          message: 'hello',
          mediaPath: 'voice_note_gran.mp3',
          connectorId: 'd81cd63b',
          config: {
            taskFollowups: true,
            action: 'send',
          },
        }),
      })

      const connector = Object.values(storage.loadConnectors())[0]
      console.log(JSON.stringify({ connector }))
    `)

    assert.equal(output.connector.name, 'Main WhatsApp')
    assert.equal(output.connector.platform, 'whatsapp')
    assert.equal(output.connector.agentId, 'agent-1')
    assert.equal(output.connector.isEnabled, true)
    assert.equal(output.connector.action, undefined)
    assert.equal(output.connector.message, undefined)
    assert.equal(output.connector.mediaPath, undefined)
    assert.equal(output.connector.connectorId, undefined)
    assert.deepEqual(output.connector.config, {
      taskFollowups: 'true',
      action: 'send',
    })
  })

  it('ignores send-like update payloads instead of mutating connector routing state', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const crudMod = await import('./src/lib/server/session-tools/crud')
      const storage = storageMod.default || storageMod
      const crud = crudMod.default || crudMod

      const now = Date.now()
      storage.saveConnectors({
        conn_1: {
          id: 'conn_1',
          name: 'Main WhatsApp',
          platform: 'whatsapp',
          agentId: 'e355bf7a',
          credentialId: 'cred-1',
          config: {
            allowFrom: 'me',
          },
          isEnabled: true,
          status: 'running',
          createdAt: now,
          updatedAt: now,
        },
      })

      const tools = crud.buildCrudTools({
        cwd: process.env.WORKSPACE_DIR,
        ctx: { sessionId: 'session-1', agentId: 'e355bf7a', platformAssignScope: 'all' },
        hasPlugin: (name) => name === 'manage_connectors',
      })
      const tool = tools.find((entry) => entry.name === 'manage_connectors')
      const raw = await tool.invoke({
        action: 'update',
        id: 'conn_1',
        data: JSON.stringify({
          action: 'send',
          message: 'hello there',
          mediaPath: 'voice_note_gran.mp3',
          connectorId: 'conn_1',
        }),
      })

      const connector = storage.loadConnectors().conn_1
      console.log(JSON.stringify({ raw, connector }))
    `)

    assert.equal(output.connector.agentId, 'e355bf7a')
    assert.equal(output.connector.credentialId, 'cred-1')
    assert.deepEqual(output.connector.config, { allowFrom: 'me' })
    assert.equal(output.connector.action, undefined)
    assert.equal(output.connector.message, undefined)
    assert.equal(output.connector.mediaPath, undefined)
    assert.equal(output.connector.connectorId, undefined)
  })
})
