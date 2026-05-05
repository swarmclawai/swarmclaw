import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

import type { BoardTask } from '@/types'

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
  SWARMCLAW_DAEMON_AUTOSTART: process.env.SWARMCLAW_DAEMON_AUTOSTART,
}

let tempDir = ''
let putTask: typeof import('./[id]/route')['PUT']
let getTasks: typeof import('./route')['GET']
let storage: typeof import('@/lib/server/storage')

function routeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

function seedTask(id: string, overrides: Partial<BoardTask> = {}) {
  const now = Date.now()
  storage.saveTasks({
    [id]: {
      id,
      title: 'Workspace Task',
      description: '',
      status: 'backlog',
      agentId: 'agent-1',
      createdAt: now,
      updatedAt: now,
      ...overrides,
    } as BoardTask,
  })
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-task-route-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  process.env.SWARMCLAW_BUILD_MODE = '1'
  process.env.SWARMCLAW_DAEMON_AUTOSTART = '0'
  storage = await import('@/lib/server/storage')
  putTask = (await import('./[id]/route')).PUT
  getTasks = (await import('./route')).GET
})

after(() => {
  if (originalEnv.DATA_DIR === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = originalEnv.DATA_DIR
  if (originalEnv.WORKSPACE_DIR === undefined) delete process.env.WORKSPACE_DIR
  else process.env.WORKSPACE_DIR = originalEnv.WORKSPACE_DIR
  if (originalEnv.SWARMCLAW_BUILD_MODE === undefined) delete process.env.SWARMCLAW_BUILD_MODE
  else process.env.SWARMCLAW_BUILD_MODE = originalEnv.SWARMCLAW_BUILD_MODE
  if (originalEnv.SWARMCLAW_DAEMON_AUTOSTART === undefined) delete process.env.SWARMCLAW_DAEMON_AUTOSTART
  else process.env.SWARMCLAW_DAEMON_AUTOSTART = originalEnv.SWARMCLAW_DAEMON_AUTOSTART
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('PUT /api/tasks/:id provisions an execution workspace and preview links', async () => {
  seedTask('task-route-workspace', {
    title: 'Route Workspace',
    projectId: 'project-route',
    cwd: '/source/repo',
  })

  const response = await putTask(new Request('http://local/api/tasks/task-route-workspace', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provisionWorkspace: true,
      previewLinks: [{ label: 'Preview', url: 'http://127.0.0.1:3456', port: 3456 }],
      runtimeServices: [{ name: 'Next dev', status: 'planned', command: 'npm run dev', port: 3456 }],
    }),
  }), routeParams('task-route-workspace'))

  assert.equal(response.status, 200)
  const body = await response.json() as BoardTask
  assert.equal(body.executionWorkspace?.sourceCwd, '/source/repo')
  assert.equal(body.executionWorkspace?.context?.taskId, 'task-route-workspace')
  assert.equal(body.executionWorkspace?.envHints?.some((hint) => hint.key === 'WORKSPACE_CWD'), true)
  assert.equal(body.previewLinks?.[0]?.url, 'http://127.0.0.1:3456')
  assert.equal(body.runtimeServices?.[0]?.name, 'Next dev')
  assert.equal(fs.existsSync(body.executionWorkspace?.path || ''), true)
  assert.equal(fs.existsSync(body.executionWorkspace?.contextPath || ''), true)
  assert.equal(fs.existsSync(body.executionWorkspace?.envPath || ''), true)
})

test('GET /api/tasks returns computed blocked liveness without persisting a task patch', async () => {
  seedTask('task-blocked', {
    title: 'Blocked Route Task',
    status: 'backlog',
    blockedBy: ['dep-route'],
  })
  const tasks = storage.loadTasks()
  tasks['dep-route'] = {
    id: 'dep-route',
    title: 'Dependency',
    description: '',
    status: 'running',
    agentId: 'agent-1',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as BoardTask
  storage.saveTasks(tasks)

  const response = await getTasks(new Request('http://local/api/tasks'))
  assert.equal(response.status, 200)
  const body = await response.json() as Record<string, BoardTask>
  assert.equal(body['task-blocked']?.liveness?.state, 'blocked')
  assert.deepEqual(body['task-blocked']?.liveness?.blockerTaskIds, ['dep-route'])
})
