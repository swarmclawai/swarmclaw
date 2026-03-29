import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildAgenticExecutionPolicy } from '@/lib/server/chat-execution/prompt-builder'

describe('buildAgenticExecutionPolicy', () => {
  it('adds a routing matrix that teaches session introspection, durable tracking, and direct routing', () => {
    const prompt = buildAgenticExecutionPolicy({
      enabledExtensions: ['memory', 'manage_sessions', 'manage_tasks', 'manage_skills', 'spawn_subagent'],
      loopMode: 'bounded',
      heartbeatPrompt: 'HEARTBEAT',
      heartbeatIntervalSec: 120,
      userMessage: 'Figure out what tools you have, then continue the task.',
      history: [],
      mode: 'minimal',
    })

    assert.ok(prompt.includes('## Routing Matrix'))
    assert.ok(prompt.includes('Current-thread facts already visible in this chat'))
    assert.ok(prompt.includes('`memory_search`'))
    assert.ok(prompt.includes('`sessions_tool` action `identity`'))
    assert.ok(prompt.includes('`sessions_tool` action `history`'))
    assert.ok(prompt.includes('`manage_tasks`'))
    assert.ok(prompt.includes('`manage_skills`'))
    assert.ok(prompt.includes('delegate or spawn a subagent'))
    assert.ok(prompt.includes('use the concrete tool now'))
    assert.ok(prompt.includes('prefer the direct `manage_*` tool'))
  })

  it('adds lightweight direct-chat guidance when classification marks the turn as lightweight', () => {
    const prompt = buildAgenticExecutionPolicy({
      enabledExtensions: ['memory', 'files', 'delegate'],
      loopMode: 'bounded',
      heartbeatPrompt: 'HEARTBEAT',
      heartbeatIntervalSec: 120,
      userMessage: 'Hello',
      history: [],
      classification: {
        taskIntent: 'general',
        isDeliverableTask: false,
        isBroadGoal: false,
        isLightweightDirectChat: true,
        hasHumanSignals: false,
        hasSignificantEvent: false,
        isResearchSynthesis: false,
        workType: 'general',
        explicitToolRequests: [],
        confidence: 0.98,
      },
    })

    assert.ok(prompt.includes('## Lightweight Chat'))
    assert.ok(prompt.includes('Reply naturally and briefly.'))
    assert.ok(prompt.includes('prefer 1-3 short sentences'))
  })
})
