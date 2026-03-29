import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..')

function readRepoSource(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf-8')
}

test('runtime hot paths use row-level task, schedule, and wallet writes', () => {
  const expectations = [
    {
      file: 'src/lib/server/runtime/scheduler.ts',
      required: ['upsertTask(', 'upsertSchedule(', 'upsertSchedules('],
      forbidden: ['saveTasks(', 'saveSchedules('],
    },
    {
      file: 'src/lib/server/schedules/schedule-route-service.ts',
      required: ['saveTask(', 'upsertSchedule('],
      forbidden: ['saveTasks(', 'saveSchedules('],
    },
    {
      file: 'src/lib/server/wallets/wallet-service.ts',
      required: ['saveWallet(', 'deleteWallet('],
      forbidden: ['saveWallets('],
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
