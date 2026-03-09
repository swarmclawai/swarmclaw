import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..')

function runWithTempDataDir(script: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-task-tool-'))
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

describe('manage_tasks tool', () => {
  it('inherits continuation context from continueFromTaskId', () => {
    const output = runWithTempDataDir(`
      import fs from 'node:fs'
      import path from 'node:path'
      const storageMod = await import('./src/lib/server/storage')
      const crudMod = await import('./src/lib/server/session-tools/crud')
      const storage = storageMod.default || storageMod
      const crud = crudMod.default || crudMod

      const now = Date.now()
      const workspaceDir = process.env.WORKSPACE_DIR
      const projectDir = path.join(workspaceDir, 'projects', 'project-1')
      fs.mkdirSync(projectDir, { recursive: true })

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
        worker: {
          id: 'worker',
          name: 'Worker',
          description: '',
          systemPrompt: '',
          provider: 'openai',
          model: 'gpt-test',
          createdAt: now,
          updatedAt: now,
        },
      })

      storage.saveTasks({
        'task-source': {
          id: 'task-source',
          title: 'Source task',
          description: 'Original work',
          status: 'completed',
          agentId: 'worker',
          projectId: 'project-1',
          cwd: projectDir,
          sessionId: 'session-source',
          codexResumeId: 'codex-thread-1',
          createdAt: now,
          updatedAt: now,
        },
      })

      const tools = crud.buildCrudTools({
        cwd: workspaceDir,
        ctx: { sessionId: 'session-creator', agentId: 'default', platformAssignScope: 'all' },
        hasPlugin: (name) => name === 'manage_tasks',
      })
      const tool = tools.find((entry) => entry.name === 'manage_tasks')
      const raw = await tool.invoke({
        action: 'create',
        title: 'Follow-up task',
        description: 'Continue the previous task with the next deliverable.',
        status: 'backlog',
        continueFromTaskId: 'task-source',
      })

      const tasks = storage.loadTasks()
      const created = Object.values(tasks).find((entry) => entry.id !== 'task-source')
      console.log(JSON.stringify({ raw, created }))
    `)

    assert.equal(output.created.projectId, 'project-1')
    assert.equal(output.created.agentId, 'worker')
    assert.equal(output.created.sessionId, 'session-source')
    assert.equal(output.created.codexResumeId, 'codex-thread-1')
    assert.deepEqual(output.created.blockedBy, ['task-source'])
  })
})
