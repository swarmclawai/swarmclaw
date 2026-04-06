import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..')

function runWithTempDataDir(script: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-swarmdock-tool-'))
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

test('swarmdock tool browses tasks with the plural skills filter', () => {
  const output = runWithTempDataDir(`
    const storageMod = await import('./src/lib/server/storage')
    const toolsMod = await import('./src/lib/server/session-tools')
    const storage = storageMod.default || storageMod
    const toolsApi = toolsMod.default || toolsMod

    let requestedUrl = null
    globalThis.fetch = async (url) => {
      requestedUrl = String(url)
      return new Response(JSON.stringify({ tasks: [{ id: 'task-1' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    storage.saveAgents({
      agent_1: {
        id: 'agent_1',
        name: 'SwarmDock Agent',
        description: 'local',
        systemPrompt: 'You are helpful.',
        provider: 'openai',
        model: 'gpt-4.1',
        swarmdockEnabled: true,
        swarmdockSkills: ['data-analysis'],
        createdAt: 1,
        updatedAt: 1,
      },
    })

    const built = await toolsApi.buildSessionTools(process.env.WORKSPACE_DIR, ['swarmdock'], {
      sessionId: 'session-1',
      agentId: 'agent_1',
      delegationEnabled: false,
      delegationTargetMode: 'all',
      delegationTargetAgentIds: [],
    })

    try {
      const tool = built.tools.find((entry) => entry.name === 'swarmdock')
      const raw = await tool.invoke({ action: 'browse_tasks', skillFilter: 'data-analysis', limit: 2 })
      console.log(JSON.stringify({ requestedUrl, body: JSON.parse(raw) }))
    } finally {
      await built.cleanup()
    }
  `)

  assert.match(String(output.requestedUrl || ''), /\/api\/v1\/tasks\?limit=2&skills=data-analysis$/)
  assert.deepEqual(output.body, { tasks: [{ id: 'task-1' }] })
})
