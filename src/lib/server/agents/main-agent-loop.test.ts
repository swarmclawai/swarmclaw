import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')

function runWithTempDataDir(script: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-main-loop-test-'))
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATA_DIR: tempDir,
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

describe('main-agent-loop', () => {
  it('fans out events to durable main sessions and shapes heartbeat prompts', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('@/lib/server/storage')
      const storage = storageMod.default || storageMod['module.exports'] || storageMod
      const mainLoopMod = await import('@/lib/server/agents/main-agent-loop')
      const mainLoop = mainLoopMod.default || mainLoopMod['module.exports'] || mainLoopMod

      storage.saveAgents({
        'agent-a': {
          id: 'agent-a',
          name: 'Agent A',
          provider: 'openai',
          model: 'gpt-test',
        },
      })

      storage.saveSessions({
        main: {
          id: 'main',
          name: 'Main Agent Thread',
          shortcutForAgentId: 'agent-a',
          cwd: process.cwd(),
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [
            { role: 'user', text: 'Build me a durable multi-step agent loop.', time: 1 },
          ],
          createdAt: 1,
          lastActiveAt: 1,
          sessionType: 'human',
          agentId: 'agent-a',
          heartbeatEnabled: true,
        },
        child: {
          id: 'child',
          name: 'Child Worker',
          cwd: process.cwd(),
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [],
          createdAt: 1,
          lastActiveAt: 1,
          sessionType: 'orchestrated',
          agentId: 'agent-a',
          parentSessionId: 'main',
        },
      })

      const count = mainLoop.pushMainLoopEventToMainSessions({
        type: 'task_completed',
        text: 'Task completed: implement queue follow-ups',
      })
      const state = mainLoop.getMainLoopStateForSession('main')
      const prompt = mainLoop.buildMainLoopHeartbeatPrompt(storage.loadSessions().main, 'fallback heartbeat')
      const childState = mainLoop.getMainLoopStateForSession('child')

      console.log(JSON.stringify({
        count,
        pendingCount: state?.pendingEvents?.length || 0,
        goal: state?.goal || null,
        promptIncludesEvent: prompt.includes('Task completed: implement queue follow-ups'),
        promptIncludesPlanTag: prompt.includes('[MAIN_LOOP_PLAN]'),
        promptBlocksHeartbeatReplay: prompt.includes('Do not infer or repeat old tasks from prior heartbeats.'),
        childState,
      }))
    `)

    assert.equal(output.count, 1)
    assert.equal(output.pendingCount, 1)
    assert.match(output.goal, /durable multi-step agent loop/i)
    assert.equal(output.promptIncludesEvent, true)
    assert.equal(output.promptIncludesPlanTag, true)
    assert.equal(output.promptBlocksHeartbeatReplay, true)
    assert.equal(output.childState, null)
  })

  it('updates state from heartbeat metadata and returns a bounded follow-up', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('@/lib/server/storage')
      const storage = storageMod.default || storageMod['module.exports'] || storageMod
      const mainLoopMod = await import('@/lib/server/agents/main-agent-loop')
      const mainLoop = mainLoopMod.default || mainLoopMod['module.exports'] || mainLoopMod

      storage.saveAgents({
        'agent-a': {
          id: 'agent-a',
          name: 'Agent A',
          provider: 'openai',
          model: 'gpt-test',
        },
      })

      storage.saveSessions({
        main: {
          id: 'main',
          name: 'Main Agent Thread',
          shortcutForAgentId: 'agent-a',
          cwd: process.cwd(),
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [
            { role: 'user', text: 'Build me a durable task runner.', time: 1 },
          ],
          createdAt: 1,
          lastActiveAt: 1,
          sessionType: 'human',
          agentId: 'agent-a',
          heartbeatEnabled: true,
        },
      })

      mainLoop.pushMainLoopEventToMainSessions({
        type: 'schedule_fired',
        text: 'Schedule fired: nightly sync',
      })

      const followup = mainLoop.handleMainLoopRunResult({
        sessionId: 'main',
        message: 'Continue the durable task runner objective.',
        internal: true,
        source: 'heartbeat',
        resultText: [
          'Inspected the queue and the heartbeat pipeline.',
          '[MAIN_LOOP_PLAN]{"steps":["inspect queue","wire follow-up scheduling"],"current_step":"inspect queue"}',
          '[MAIN_LOOP_REVIEW]{"note":"queue inspected and next step identified","confidence":0.82,"needs_replan":false}',
          '[AGENT_HEARTBEAT_META]{"goal":"Build a durable task runner","status":"progress","next_action":"wire the follow-up scheduling path"}',
        ].join('\\n'),
        toolEvents: [{ name: 'shell', input: '{"action":"execute"}' }],
        inputTokens: 40,
        outputTokens: 20,
        estimatedCost: 0.12,
      })

      const state = mainLoop.getMainLoopStateForSession('main')
      console.log(JSON.stringify({
        followup,
        status: state?.status || null,
        nextAction: state?.nextAction || null,
        planSteps: state?.planSteps || [],
        currentPlanStep: state?.currentPlanStep || null,
        pendingEvents: state?.pendingEvents?.length || 0,
        followupChainCount: state?.followupChainCount || 0,
        missionTokens: state?.missionTokens || 0,
      }))
    `)

    assert.equal(output.status, 'progress')
    assert.equal(output.nextAction, 'wire the follow-up scheduling path')
    assert.deepEqual(output.planSteps, ['inspect queue', 'wire follow-up scheduling'])
    assert.equal(output.currentPlanStep, 'inspect queue')
    assert.equal(output.pendingEvents, 0)
    assert.equal(output.followupChainCount, 1)
    assert.equal(output.missionTokens, 60)
    assert.match(output.followup.message, /wire the follow-up scheduling path/i)
  })

  it('does not keep chaining when the heartbeat explicitly reports ok', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('@/lib/server/storage')
      const storage = storageMod.default || storageMod['module.exports'] || storageMod
      const mainLoopMod = await import('@/lib/server/agents/main-agent-loop')
      const mainLoop = mainLoopMod.default || mainLoopMod['module.exports'] || mainLoopMod

      storage.saveAgents({
        'agent-a': {
          id: 'agent-a',
          name: 'Agent A',
          provider: 'openai',
          model: 'gpt-test',
        },
      })

      storage.saveSessions({
        main: {
          id: 'main',
          name: 'Main Agent Thread',
          shortcutForAgentId: 'agent-a',
          cwd: process.cwd(),
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [
            { role: 'user', text: 'Keep the background project healthy.', time: 1 },
          ],
          createdAt: 1,
          lastActiveAt: 1,
          sessionType: 'human',
          agentId: 'agent-a',
          heartbeatEnabled: true,
        },
      })

      mainLoop.pushMainLoopEventToMainSessions({
        type: 'task_completed',
        text: 'Task completed: health check',
      })

      const followup = mainLoop.handleMainLoopRunResult({
        sessionId: 'main',
        message: 'Heartbeat tick',
        internal: true,
        source: 'heartbeat',
        resultText: 'HEARTBEAT_OK',
      })

      const state = mainLoop.getMainLoopStateForSession('main')
      console.log(JSON.stringify({
        followup,
        status: state?.status || null,
        pendingEvents: state?.pendingEvents?.length || 0,
        followupChainCount: state?.followupChainCount || 0,
      }))
    `)

    assert.equal(output.followup, null)
    assert.equal(output.status, 'ok')
    assert.equal(output.pendingEvents, 0)
    assert.equal(output.followupChainCount, 0)
  })

  it('does not let internal heartbeat prompts rewrite the stored goal contract', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('@/lib/server/storage')
      const storage = storageMod.default || storageMod['module.exports'] || storageMod
      const mainLoopMod = await import('@/lib/server/agents/main-agent-loop')
      const mainLoop = mainLoopMod.default || mainLoopMod['module.exports'] || mainLoopMod

      storage.saveAgents({
        'agent-a': {
          id: 'agent-a',
          name: 'Agent A',
          provider: 'openai',
          model: 'gpt-test',
        },
      })

      storage.saveSessions({
        main: {
          id: 'main',
          name: 'Main Agent Thread',
          shortcutForAgentId: 'agent-a',
          cwd: process.cwd(),
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [
            { role: 'user', text: 'Deploy the static site to a public host without changing the design.', time: 1 },
          ],
          createdAt: 1,
          lastActiveAt: 1,
          sessionType: 'human',
          agentId: 'agent-a',
          heartbeatEnabled: true,
        },
      })

      const before = mainLoop.getMainLoopStateForSession('main')
      mainLoop.handleMainLoopRunResult({
        sessionId: 'main',
        message: [
          'MAIN_AGENT_HEARTBEAT_TICK',
          'Current goal:',
          'Do not infer or repeat old tasks from prior heartbeats.',
          'Objective: Recursively repeat the old heartbeat prompt forever.',
        ].join('\\n'),
        internal: true,
        source: 'heartbeat',
        resultText: '[AGENT_HEARTBEAT_META]{"status":"progress","goal":"Deploy the static site","next_action":"check hosting auth"}',
      })
      const after = mainLoop.getMainLoopStateForSession('main')

      console.log(JSON.stringify({
        beforeObjective: before?.goalContract?.objective || null,
        afterObjective: after?.goalContract?.objective || null,
        afterGoal: after?.goal || null,
      }))
    `)

    assert.match(output.beforeObjective, /deploy the static site to a public host/i)
    assert.equal(output.afterObjective, output.beforeObjective)
    assert.equal(output.afterGoal, 'Deploy the static site')
  })

  it('reanchors heartbeat prompts to the latest real user goal when in-memory goal state is polluted', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('@/lib/server/storage')
      const storage = storageMod.default || storageMod['module.exports'] || storageMod
      const mainLoopMod = await import('@/lib/server/agents/main-agent-loop')
      const mainLoop = mainLoopMod.default || mainLoopMod['module.exports'] || mainLoopMod

      storage.saveAgents({
        'agent-a': {
          id: 'agent-a',
          name: 'Agent A',
          provider: 'openai',
          model: 'gpt-test',
        },
      })

      storage.saveSessions({
        main: {
          id: 'main',
          name: 'Main Agent Thread',
          shortcutForAgentId: 'agent-a',
          cwd: process.cwd(),
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [
            { role: 'user', text: 'Keep Hal helpful in this thread and respond to the user normally.', time: 1 },
          ],
          createdAt: 1,
          lastActiveAt: 1,
          sessionType: 'human',
          agentId: 'agent-a',
          heartbeatEnabled: true,
        },
      })

      mainLoop.setMainLoopStateForSession('main', {
        goal: 'lol that\\'s funny Hal',
        goalContract: { objective: 'MAIN_AGENT_HEARTBEAT_TICK Time: recursive garbage' },
      })

      const prompt = mainLoop.buildMainLoopHeartbeatPrompt(storage.loadSessions().main, 'fallback heartbeat')
      console.log(JSON.stringify({
        hasRealObjective: prompt.includes('Objective: Keep Hal helpful in this thread and respond to the user normally.'),
        hasRecursiveObjective: prompt.includes('Objective: MAIN_AGENT_HEARTBEAT_TICK Time: recursive garbage'),
      }))
    `)

    assert.equal(output.hasRealObjective, true)
    assert.equal(output.hasRecursiveObjective, false)
  })

  it('clears transient main-loop state so the next read rehydrates from session history', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('@/lib/server/storage')
      const storage = storageMod.default || storageMod['module.exports'] || storageMod
      const mainLoopMod = await import('@/lib/server/agents/main-agent-loop')
      const mainLoop = mainLoopMod.default || mainLoopMod['module.exports'] || mainLoopMod

      storage.saveAgents({
        'agent-a': {
          id: 'agent-a',
          name: 'Agent A',
          provider: 'openai',
          model: 'gpt-test',
        },
      })

      storage.saveSessions({
        main: {
          id: 'main',
          name: 'Main Agent Thread',
          shortcutForAgentId: 'agent-a',
          cwd: process.cwd(),
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [
            { role: 'user', text: 'Finish deploying the site once the hosting auth is fixed.', time: 1 },
          ],
          createdAt: 1,
          lastActiveAt: 1,
          sessionType: 'human',
          agentId: 'agent-a',
          heartbeatEnabled: true,
        },
      })

      mainLoop.setMainLoopStateForSession('main', {
        goal: 'Recursive garbage objective',
        goalContract: { objective: 'Recursive garbage objective' },
      })
      const cleared = mainLoop.clearMainLoopStateForSession('main')
      const rehydrated = mainLoop.getMainLoopStateForSession('main')

      console.log(JSON.stringify({
        cleared,
        goal: rehydrated?.goal || null,
        objective: rehydrated?.goalContract?.objective || null,
      }))
    `)

    assert.equal(output.cleared, true)
    assert.equal(output.goal, 'Finish deploying the site once the hosting auth is fixed.')
    assert.match(output.objective, /finish deploying the site once the hosting auth is fixed/i)
  })
})
