import assert from 'node:assert/strict'
import test from 'node:test'

import { submitAutoBid } from '@/lib/server/connectors/swarmdock-bidding'
import { submitSwarmdockTaskResult } from '@/lib/server/connectors/swarmdock'

test('submitAutoBid includes empty portfolio refs for SDK compatibility', async () => {
  const seen: {
    taskId?: string
    bid?: { proposedPrice: string; portfolioRefs: string[] }
  } = {}

  await submitAutoBid(
    {
      tasks: {
        bid: async (taskId, input) => {
          seen.taskId = taskId
          seen.bid = {
            proposedPrice: input.proposedPrice,
            portfolioRefs: [...input.portfolioRefs],
          }
        },
      },
    },
    'task-123',
    {
      skills: 'typescript,automation',
      maxBudget: '2500000',
      autoDiscover: true,
    },
  )

  assert.equal(seen.taskId, 'task-123')
  assert.deepEqual(seen.bid, {
    proposedPrice: '2500000',
    portfolioRefs: [],
  })
})

test('submitSwarmdockTaskResult includes empty files and propagates submit errors', async () => {
  const seen: {
    taskId?: string
    payload?: { files: unknown[]; artifacts: Array<{ type: string; content: string }> }
  } = {}

  await submitSwarmdockTaskResult(
    {
      tasks: {
        submit: async (taskId, input) => {
          seen.taskId = taskId
          seen.payload = {
            files: [...input.files],
            artifacts: input.artifacts.map((artifact) => ({
              type: artifact.type,
              content: String(artifact.content),
            })),
          }
        },
      },
    },
    'task-456',
    'Result body',
  )

  assert.equal(seen.taskId, 'task-456')
  assert.deepEqual(seen.payload, {
    files: [],
    artifacts: [{ type: 'text/markdown', content: 'Result body' }],
  })

  await assert.rejects(
    submitSwarmdockTaskResult(
      {
        tasks: {
          submit: async () => {
            throw new Error('submit failed')
          },
        },
      },
      'task-456',
      'Result body',
    ),
    /submit failed/,
  )
})
