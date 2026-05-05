import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import type { BoardTask } from '@/types'

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
}

let tempDir = ''
let workspace: typeof import('@/lib/server/tasks/task-execution-workspace')

function makeTask(overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    id: 'task-1',
    title: 'Ship preview URLs',
    description: 'Prepare an isolated task workspace.',
    status: 'backlog',
    agentId: 'agent-1',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as BoardTask
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-task-workspace-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  process.env.SWARMCLAW_BUILD_MODE = '1'
  workspace = await import('@/lib/server/tasks/task-execution-workspace')
})

after(() => {
  if (originalEnv.DATA_DIR === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = originalEnv.DATA_DIR
  if (originalEnv.WORKSPACE_DIR === undefined) delete process.env.WORKSPACE_DIR
  else process.env.WORKSPACE_DIR = originalEnv.WORKSPACE_DIR
  if (originalEnv.SWARMCLAW_BUILD_MODE === undefined) delete process.env.SWARMCLAW_BUILD_MODE
  else process.env.SWARMCLAW_BUILD_MODE = originalEnv.SWARMCLAW_BUILD_MODE
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('task execution workspaces', () => {
  it('provisions a deterministic task workspace with preview metadata', () => {
    const task = makeTask({
      id: 'task-alpha',
      title: 'Launch QA / preview',
      cwd: '/repo/source',
      projectId: 'project-1',
    })

    const patch = workspace.prepareTaskExecutionWorkspace(task, {
      now: 100,
      actor: 'test',
      previewLinks: [{ label: 'Local preview', url: 'http://127.0.0.1:3456', port: 3456 }],
      runtimeServices: [{ name: 'Next dev', status: 'planned', command: 'npm run dev', port: 3456 }],
    })

    assert.match(patch.executionWorkspace.path, /project-1/)
    assert.match(patch.executionWorkspace.path, /task-alpha-launch-qa-preview/)
    assert.equal(fs.existsSync(patch.executionWorkspace.path), true)
    assert.equal(fs.existsSync(patch.executionWorkspace.readmePath || ''), true)
    assert.equal(fs.existsSync(patch.executionWorkspace.contextPath || ''), true)
    assert.equal(fs.existsSync(patch.executionWorkspace.envPath || ''), true)
    assert.equal(patch.executionWorkspace.sourceCwd, '/repo/source')
    assert.equal(patch.executionWorkspace.context?.taskId, 'task-alpha')
    assert.equal(patch.executionWorkspace.context?.workspacePath, patch.executionWorkspace.path)
    assert.equal(patch.executionWorkspace.envHints?.some((hint) => hint.key === 'WORKSPACE_CWD'), true)
    assert.equal(patch.executionWorkspace.envHints?.some((hint) => hint.key === 'KANBAN_TASK_ID'), true)
    assert.equal(patch.executionWorkspace.previewLinks[0]?.label, 'Local preview')
    assert.equal(patch.previewLinks[0]?.url, 'http://127.0.0.1:3456')
    assert.equal(patch.runtimeServices[0]?.status, 'planned')

    const context = JSON.parse(fs.readFileSync(patch.executionWorkspace.contextPath || '', 'utf8'))
    assert.equal(context.taskId, 'task-alpha')
    assert.equal(context.previewLinks[0]?.url, 'http://127.0.0.1:3456')
    const envFile = fs.readFileSync(patch.executionWorkspace.envPath || '', 'utf8')
    assert.equal(envFile.includes('SWARMCLAW_TASK_ID="task-alpha"'), true)
    assert.equal(envFile.includes('WORKSPACE_SOURCE="/repo/source"'), true)
    assert.equal(envFile.includes('KANBAN_WORKSPACE='), true)
  })

  it('deduplicates preview URLs and computes blocked, stale, and retrying liveness', () => {
    const task = makeTask({
      id: 'task-beta',
      status: 'running',
      startedAt: 10,
      updatedAt: 10,
      lastActivityAt: 10,
      previewLinks: [{ id: 'old', label: 'Existing', url: 'http://localhost:3000', kind: 'web', addedAt: 5 }],
    })

    const patch = workspace.prepareTaskExecutionWorkspace(task, {
      now: 100,
      previewLinks: [
        { label: 'Duplicate', url: 'http://localhost:3000' },
        { label: 'Docs', url: 'http://localhost:3000/docs', kind: 'docs' },
      ],
    })

    assert.equal(patch.previewLinks.length, 2)
    assert.equal(patch.previewLinks[0]?.label, 'Existing')
    assert.equal(patch.previewLinks[1]?.kind, 'docs')

    const stale = workspace.computeTaskLiveness(task, {}, { now: 100, staleAfterMs: 50 })
    assert.equal(stale.state, 'stale')
    assert.match(stale.reason, /No activity/)

    const blocked = workspace.computeTaskLiveness(makeTask({
      status: 'queued',
      blockedBy: ['dep-1'],
    }), {
      'dep-1': makeTask({ id: 'dep-1', status: 'running' }),
    }, { now: 100 })
    assert.equal(blocked.state, 'blocked')
    assert.deepEqual(blocked.blockerTaskIds, ['dep-1'])

    const retrying = workspace.computeTaskLiveness(makeTask({
      status: 'queued',
      retryScheduledAt: 150,
    }), {}, { now: 100 })
    assert.equal(retrying.state, 'retrying')
    assert.equal(retrying.nextWakeAt, 150)
  })
})
