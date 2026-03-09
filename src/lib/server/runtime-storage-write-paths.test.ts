import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')

function readRepoSource(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf-8')
}

test('runtime hot paths use row-level task, schedule, and agent writes', () => {
  const expectations = [
    {
      file: 'src/lib/server/queue',
      required: ['patchTask(', 'upsertTask(', 'upsertTasks(', 'upsertSchedule(', 'deleteSchedule('],
      forbidden: ['saveTasks(', 'saveSchedules('],
    },
    {
      file: 'src/lib/server/scheduler',
      required: ['upsertTask(', 'upsertSchedule(', 'upsertSchedules('],
      forbidden: ['saveTasks(', 'saveSchedules('],
    },
    {
      file: 'src/lib/server/orchestrator-lg',
      required: ['patchTask(', 'upsertTask('],
      forbidden: ['saveTasks('],
    },
    {
      file: 'src/app/api/orchestrator/run/route',
      required: ['upsertTask('],
      forbidden: ['saveTasks('],
    },
    {
      file: 'src/app/api/schedules/[id]/run/route',
      required: ['upsertTask(', 'upsertSchedule('],
      forbidden: ['saveTasks(', 'saveSchedules('],
    },
    {
      file: 'src/app/api/tasks/[id]/approve/route',
      required: ['patchTask('],
      forbidden: ['saveTasks('],
    },
    {
      file: 'src/lib/server/wallet-service',
      required: ['loadAgent(', 'upsertAgent('],
      forbidden: ['saveAgents('],
    },
  ] as const

  for (const expectation of expectations) {
    const src = readRepoSource(expectation.file)
    for (const token of expectation.required) {
      assert.equal(src.includes(token), true, `${expectation.file} should use ${token}`)
    }
    for (const token of expectation.forbidden) {
      assert.equal(src.includes(token), false, `${expectation.file} should not use ${token}`)
    }
  }
})
