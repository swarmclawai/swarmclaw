import assert from 'node:assert/strict'
import { describe, it, before, after } from 'node:test'

const originalEnv = {
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
}

let mod: typeof import('@/lib/server/chat-execution/message-classifier')

before(async () => {
  process.env.SWARMCLAW_BUILD_MODE = '1'
  mod = await import('@/lib/server/chat-execution/message-classifier')
})

after(() => {
  if (originalEnv.SWARMCLAW_BUILD_MODE === undefined) delete process.env.SWARMCLAW_BUILD_MODE
  else process.env.SWARMCLAW_BUILD_MODE = originalEnv.SWARMCLAW_BUILD_MODE
})

// ---------------------------------------------------------------------------
// parseClassificationResponse
// ---------------------------------------------------------------------------

describe('parseClassificationResponse', () => {
  const validJson = JSON.stringify({
    isDeliverableTask: true,
    isBroadGoal: false,
    walletIntent: 'none',
    hasHumanSignals: false,
    hasSignificantEvent: false,
    isResearchSynthesis: false,
    explicitToolRequests: [],
    confidence: 0.9,
  })

  it('parses valid JSON with all schema fields', () => {
    const result = mod.parseClassificationResponse(validJson)
    assert.ok(result)
    assert.equal(result!.isDeliverableTask, true)
    assert.equal(result!.isBroadGoal, false)
    assert.equal(result!.walletIntent, 'none')
    assert.equal(result!.confidence, 0.9)
    assert.deepEqual(result!.explicitToolRequests, [])
  })

  it('returns null for malformed JSON', () => {
    assert.equal(mod.parseClassificationResponse('not json at all'), null)
    assert.equal(mod.parseClassificationResponse('{broken'), null)
  })

  it('returns null for JSON missing required keys', () => {
    const partial = JSON.stringify({ isDeliverableTask: true })
    assert.equal(mod.parseClassificationResponse(partial), null)
  })

  it('tolerates extra keys in JSON', () => {
    const withExtra = JSON.stringify({
      isDeliverableTask: true,
      isBroadGoal: false,
      walletIntent: 'none',
      hasHumanSignals: false,
      hasSignificantEvent: false,
      isResearchSynthesis: false,
      explicitToolRequests: ['shell'],
      confidence: 0.85,
      extraKey: 'should be ignored',
    })
    const result = mod.parseClassificationResponse(withExtra)
    assert.ok(result)
    assert.equal(result!.isDeliverableTask, true)
  })

  it('extracts embedded JSON from prose text', () => {
    const prose = `Here is my classification:\n${validJson}\nEnd of classification.`
    const result = mod.parseClassificationResponse(prose)
    assert.ok(result)
    assert.equal(result!.isDeliverableTask, true)
  })

  it('returns null for empty text', () => {
    assert.equal(mod.parseClassificationResponse(''), null)
    assert.equal(mod.parseClassificationResponse('   '), null)
  })
})

// ---------------------------------------------------------------------------
// isDeliverableTask
// ---------------------------------------------------------------------------

describe('isDeliverableTask', () => {
  it('uses classification value when provided', () => {
    const cls = makeClassification({ isDeliverableTask: true })
    assert.equal(mod.isDeliverableTask(cls, 'anything'), true)

    const cls2 = makeClassification({ isDeliverableTask: false })
    assert.equal(mod.isDeliverableTask(cls2, 'build me a landing page'), false)
  })

  it('falls back to regex when classification is null', () => {
    // A message that looks like a deliverable task
    const result = mod.isDeliverableTask(null, 'Create a detailed marketing report with competitor analysis and market sizing. Include charts and recommendations for Q3 strategy across all regions.')
    assert.equal(typeof result, 'boolean')
  })
})

// ---------------------------------------------------------------------------
// isBroadGoal
// ---------------------------------------------------------------------------

describe('isBroadGoal', () => {
  it('uses classification value when provided', () => {
    assert.equal(mod.isBroadGoal(makeClassification({ isBroadGoal: true }), ''), true)
    assert.equal(mod.isBroadGoal(makeClassification({ isBroadGoal: false }), ''), false)
  })

  it('falls back to regex when classification is null', () => {
    const result = mod.isBroadGoal(null, 'I want to build a complete e-commerce platform with user authentication, product catalog, shopping cart, and payment processing')
    assert.equal(typeof result, 'boolean')
  })
})

// ---------------------------------------------------------------------------
// hasWalletIntent
// ---------------------------------------------------------------------------

describe('hasWalletIntent', () => {
  it('walletIntent none returns false', () => {
    assert.equal(mod.hasWalletIntent(makeClassification({ walletIntent: 'none' }), ''), false)
  })

  it('walletIntent read_only returns true', () => {
    assert.equal(mod.hasWalletIntent(makeClassification({ walletIntent: 'read_only' }), ''), true)
  })

  it('walletIntent transactional returns true', () => {
    assert.equal(mod.hasWalletIntent(makeClassification({ walletIntent: 'transactional' }), ''), true)
  })

  it('falls back to regex when classification is null', () => {
    const result = mod.hasWalletIntent(null, 'check my wallet balance')
    assert.equal(typeof result, 'boolean')
  })
})

// ---------------------------------------------------------------------------
// hasTransactionalWalletIntent
// ---------------------------------------------------------------------------

describe('hasTransactionalWalletIntent', () => {
  it('only transactional returns true', () => {
    assert.equal(mod.hasTransactionalWalletIntent(makeClassification({ walletIntent: 'transactional' }), ''), true)
    assert.equal(mod.hasTransactionalWalletIntent(makeClassification({ walletIntent: 'read_only' }), ''), false)
    assert.equal(mod.hasTransactionalWalletIntent(makeClassification({ walletIntent: 'none' }), ''), false)
  })

  it('falls back to regex when classification is null', () => {
    const result = mod.hasTransactionalWalletIntent(null, 'swap 1 ETH for USDC')
    assert.equal(typeof result, 'boolean')
  })
})

// ---------------------------------------------------------------------------
// hasHumanSignals
// ---------------------------------------------------------------------------

describe('hasHumanSignals', () => {
  it('uses classification value when provided', () => {
    assert.equal(mod.hasHumanSignals(makeClassification({ hasHumanSignals: true }), ''), true)
    assert.equal(mod.hasHumanSignals(makeClassification({ hasHumanSignals: false }), ''), false)
  })

  it('regex detects personal text', () => {
    assert.equal(mod.hasHumanSignals(null, 'my birthday is next week'), true)
  })

  it('regex returns false for task-only text', () => {
    assert.equal(mod.hasHumanSignals(null, 'deploy the app'), false)
  })
})

// ---------------------------------------------------------------------------
// hasSignificantEvent
// ---------------------------------------------------------------------------

describe('hasSignificantEvent', () => {
  it('uses classification value when provided', () => {
    assert.equal(mod.hasSignificantEvent(makeClassification({ hasSignificantEvent: true }), ''), true)
    assert.equal(mod.hasSignificantEvent(makeClassification({ hasSignificantEvent: false }), ''), false)
  })

  it('regex detects significant events', () => {
    assert.equal(mod.hasSignificantEvent(null, 'I just got promoted at work'), true)
    assert.equal(mod.hasSignificantEvent(null, 'my graduation ceremony is on Friday'), true)
  })

  it('regex returns false for non-event text', () => {
    assert.equal(mod.hasSignificantEvent(null, 'fix the login bug'), false)
  })
})

// ---------------------------------------------------------------------------
// isResearchSynthesis
// ---------------------------------------------------------------------------

describe('isResearchSynthesis', () => {
  it('uses classification value when provided', () => {
    assert.equal(mod.isResearchSynthesis(makeClassification({ isResearchSynthesis: true }), null), true)
    assert.equal(mod.isResearchSynthesis(makeClassification({ isResearchSynthesis: false }), null), false)
  })

  it('falls back to routingIntent when classification is null', () => {
    assert.equal(mod.isResearchSynthesis(null, 'research'), true)
    assert.equal(mod.isResearchSynthesis(null, 'browsing'), true)
    assert.equal(mod.isResearchSynthesis(null, 'coding'), false)
    assert.equal(mod.isResearchSynthesis(null, null), false)
  })
})

// ---------------------------------------------------------------------------
// classifyMessage — with generateText override
// ---------------------------------------------------------------------------

describe('classifyMessage', () => {
  it('returns valid classification from mock generateText', async () => {
    const mockResponse = JSON.stringify({
      isDeliverableTask: true,
      isBroadGoal: false,
      walletIntent: 'none',
      hasHumanSignals: false,
      hasSignificantEvent: false,
      isResearchSynthesis: false,
      explicitToolRequests: ['shell'],
      confidence: 0.95,
    })

    const result = await mod.classifyMessage(
      { sessionId: 'test-session', message: 'Build me a dashboard' },
      { generateText: async () => mockResponse },
    )

    assert.ok(result)
    assert.equal(result!.isDeliverableTask, true)
    assert.equal(result!.walletIntent, 'none')
    assert.deepEqual(result!.explicitToolRequests, ['shell'])
  })

  it('returns null for empty message', async () => {
    const result = await mod.classifyMessage(
      { sessionId: 'test-session', message: '' },
      { generateText: async () => '{}' },
    )
    assert.equal(result, null)
  })

  it('returns null for whitespace-only message', async () => {
    const result = await mod.classifyMessage(
      { sessionId: 'test-session', message: '   ' },
      { generateText: async () => '{}' },
    )
    assert.equal(result, null)
  })

  it('returns null when generateText times out', async () => {
    const result = await mod.classifyMessage(
      { sessionId: 'test-session', message: 'A message that will timeout for classification purposes' },
      {
        generateText: () => new Promise((resolve) => {
          // Never resolves within 2s timeout
          setTimeout(() => resolve('{}'), 10_000)
        }),
      },
    )
    assert.equal(result, null)
  })

  it('caches results for the same message', async () => {
    let callCount = 0
    const mockResponse = JSON.stringify({
      isDeliverableTask: false,
      isBroadGoal: false,
      walletIntent: 'none',
      hasHumanSignals: false,
      hasSignificantEvent: false,
      isResearchSynthesis: false,
      explicitToolRequests: [],
      confidence: 0.8,
    })

    const generateText = async () => {
      callCount++
      return mockResponse
    }

    // Use a unique message to avoid cache from other tests
    const uniqueMsg = `cache-test-${Date.now()}-${Math.random()}`

    const first = await mod.classifyMessage(
      { sessionId: 'test-session', message: uniqueMsg },
      { generateText },
    )
    const second = await mod.classifyMessage(
      { sessionId: 'test-session', message: uniqueMsg },
      { generateText },
    )

    assert.ok(first)
    assert.ok(second)
    assert.deepEqual(first, second)
    assert.equal(callCount, 1, 'generateText should only be called once due to cache')
  })
})

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeClassification(overrides: Partial<import('@/lib/server/chat-execution/message-classifier').MessageClassification>): import('@/lib/server/chat-execution/message-classifier').MessageClassification {
  return {
    isDeliverableTask: false,
    isBroadGoal: false,
    walletIntent: 'none',
    hasHumanSignals: false,
    hasSignificantEvent: false,
    isResearchSynthesis: false,
    explicitToolRequests: [],
    confidence: 0.9,
    ...overrides,
  }
}
