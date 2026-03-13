import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'

import { assessAutonomyRun } from '@/lib/server/autonomy/supervisor-reflection'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..')

function runWithTempDataDir(script: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-supervisor-reflection-'))
  try {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          DATA_DIR: tempDir,
          WORKSPACE_DIR: path.join(tempDir, 'workspace'),
          SWARMCLAW_BUILD_MODE: '1',
        },
        encoding: 'utf-8',
        timeout: 20000,
      },
    )
    assert.equal(result.status, 0, result.stderr || result.stdout || 'subprocess failed')
    const lines = (result.stdout || '')
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    const jsonLine = [...lines].reverse().find((line) => line.startsWith('{'))
    return JSON.parse(jsonLine || '{}') as Record<string, unknown>
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

describe('supervisor-reflection', () => {
  it('recommends an automatic supervisor recovery step for repeated tool thrash', () => {
    const assessment = assessAutonomyRun({
      runId: 'run-1',
      sessionId: 'session-1',
      source: 'chat',
      status: 'completed',
      resultText: 'Retried the same shell command and got the same output.',
      toolEvents: [
        { name: 'shell', input: '{"cmd":"npm test"}' },
        { name: 'shell', input: '{"cmd":"npm test"}' },
        { name: 'shell', input: '{"cmd":"npm test"}' },
      ],
      mainLoopState: {
        followupChainCount: 1,
        summary: 'Retried the same shell command and got the same output.',
      },
      settings: {
        supervisorEnabled: true,
        supervisorRuntimeScope: 'both',
        supervisorRepeatedToolLimit: 3,
        supervisorNoProgressLimit: 2,
        reflectionEnabled: true,
        reflectionAutoWriteMemory: true,
      },
      session: {
        id: 'session-1',
        name: 'Autonomy Test',
        cwd: process.cwd(),
        user: 'tester',
        provider: 'openai',
        model: 'gpt-test',
        claudeSessionId: null,
        messages: [],
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      } as any,
    })

    assert.ok(assessment.incidents.some((incident) => incident.kind === 'repeated_tool'))
    assert.match(String(assessment.interventionPrompt || ''), /stop repeating shell/i)
    assert.equal(assessment.shouldBlock, false)
  })

  it('persists reflections and auto-written reflection memory', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('@/lib/server/storage')
      const storage = storageMod.default || storageMod['module.exports'] || storageMod
      const reflectionMod = await import('@/lib/server/autonomy/supervisor-reflection')
      const mod = reflectionMod.default || reflectionMod['module.exports'] || reflectionMod
      const memoryDbMod = await import('@/lib/server/memory/memory-db')
      const memoryMod = memoryDbMod.default || memoryDbMod['module.exports'] || memoryDbMod

      storage.saveAgents({
        'agent-a': {
          id: 'agent-a',
          name: 'Agent A',
          provider: 'openai',
          model: 'gpt-test',
        },
      })

      storage.saveSessions({
        s1: {
          id: 's1',
          name: 'Autonomy Session',
          cwd: process.cwd(),
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [
            { role: 'user', text: 'Repair the deployment workflow and keep notes for later.', time: 1 },
            { role: 'assistant', text: 'I retried the same shell path and nothing changed.', time: 2 },
          ],
          createdAt: 1,
          lastActiveAt: 2,
          sessionType: 'human',
          agentId: 'agent-a',
        },
      })

      storage.saveSettings({
        supervisorEnabled: true,
        supervisorRuntimeScope: 'both',
        supervisorNoProgressLimit: 2,
        supervisorRepeatedToolLimit: 3,
        reflectionEnabled: true,
        reflectionAutoWriteMemory: true,
      })

      const result = await mod.observeAutonomyRunOutcome({
        runId: 'run-1',
        sessionId: 's1',
        agentId: 'agent-a',
        source: 'chat',
        status: 'completed',
        resultText: 'I retried the same shell path and nothing changed.',
        toolEvents: [
          { name: 'shell', input: '{"cmd":"npm test"}' },
          { name: 'shell', input: '{"cmd":"npm test"}' },
          { name: 'shell', input: '{"cmd":"npm test"}' },
        ],
        mainLoopState: {
          followupChainCount: 2,
          summary: 'I retried the same shell path and nothing changed.',
        },
        sourceMessage: 'Repair the deployment workflow and keep notes for later.',
      }, {
        generateText: async () => JSON.stringify({
          summary: 'Deployment repair reflection',
          invariants: ['Verify changed files and command output before marking the task complete.'],
          derived: ['Switch recovery strategy after two identical shell failures in a row.'],
          failures: ['Repeated shell retries without changing inputs waste budget.'],
          lessons: ['Capture a short recovery brief before continuing a stuck run.'],
          communication: ['Keep execution updates concise when reporting repair progress.'],
          relationship: ['Treat the user as wanting decisive recovery rather than repeated status chatter.'],
          significant_events: ['The deployment workflow is currently broken and needs a confirmed repair path.'],
          profile: ['The user is directly responsible for the deployment workflow.'],
          boundaries: ['Do not claim the repair is complete without concrete verification evidence.'],
          open_loops: ['Follow up with the final verification result once the repair path succeeds.'],
        }),
      })

      const memories = memoryMod.getMemoryDb().list(undefined, 50)
        .filter((entry) => entry.metadata && entry.metadata.origin === 'autonomy-reflection')

      console.log(JSON.stringify({
        incidentKinds: result.incidents.map((incident) => incident.kind).sort(),
        reflectionSummary: result.reflection?.summary ?? null,
        reflectionCount: mod.listRunReflections({ sessionId: 's1' }).length,
        autoMemoryCount: result.reflection?.autoMemoryIds?.length ?? 0,
        memoryCategories: memories.map((entry) => entry.category).sort(),
        profileNotes: result.reflection?.profileNotes ?? [],
        boundaryNotes: result.reflection?.boundaryNotes ?? [],
        openLoopNotes: result.reflection?.openLoopNotes ?? [],
      }))
    `)

    assert.deepEqual(output.incidentKinds, ['no_progress', 'repeated_tool'])
    assert.equal(output.reflectionSummary, 'Deployment repair reflection')
    assert.equal(output.reflectionCount, 1)
    assert.equal(output.autoMemoryCount, 10)
    assert.deepEqual(output.profileNotes, ['The user is directly responsible for the deployment workflow.'])
    assert.deepEqual(output.boundaryNotes, ['Do not claim the repair is complete without concrete verification evidence.'])
    assert.deepEqual(output.openLoopNotes, ['Follow up with the final verification result once the repair path succeeds.'])
    assert.deepEqual(output.memoryCategories, [
      'reflection/boundary',
      'reflection/communication',
      'reflection/derived',
      'reflection/failure',
      'reflection/invariant',
      'reflection/lesson',
      'reflection/open_loop',
      'reflection/profile',
      'reflection/relationship',
      'reflection/significant_event',
    ])
  })

  it('reflects short human chats when they contain durable personal context', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('@/lib/server/storage')
      const storage = storageMod.default || storageMod['module.exports'] || storageMod
      const reflectionMod = await import('@/lib/server/autonomy/supervisor-reflection')
      const mod = reflectionMod.default || reflectionMod['module.exports'] || reflectionMod

      storage.saveAgents({
        'agent-a': {
          id: 'agent-a',
          name: 'Agent A',
          provider: 'openai',
          model: 'gpt-test',
        },
      })

      storage.saveSessions({
        s2: {
          id: 's2',
          name: 'Human Context Session',
          cwd: process.cwd(),
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [
            { role: 'user', text: 'I am moving to Lisbon next month and prefer short check-ins while I am juggling the move.', time: 1 },
            { role: 'assistant', text: 'Understood. I will keep updates tight and remember the move timing.', time: 2 },
          ],
          createdAt: 1,
          lastActiveAt: 2,
          sessionType: 'human',
          agentId: 'agent-a',
        },
      })

      storage.saveSettings({
        supervisorEnabled: true,
        supervisorRuntimeScope: 'both',
        supervisorNoProgressLimit: 2,
        supervisorRepeatedToolLimit: 3,
        reflectionEnabled: true,
        reflectionAutoWriteMemory: true,
      })

      const result = await mod.observeAutonomyRunOutcome({
        runId: 'run-human',
        sessionId: 's2',
        agentId: 'agent-a',
        source: 'chat',
        status: 'completed',
        resultText: 'I will keep updates tight and remember the move timing.',
        sourceMessage: 'I am moving to Lisbon next month and prefer short check-ins while I am juggling the move.',
      }, {
        generateText: async () => JSON.stringify({
          summary: 'Human context reflection',
          communication: ['Prefer short check-ins while the move is in progress.'],
          significant_events: ['Moving to Lisbon next month.'],
          open_loops: ['Check in again once the move is complete.'],
          profile: ['Currently planning a move to Lisbon.'],
        }),
      })

      console.log(JSON.stringify({
        reflectionSummary: result.reflection?.summary ?? null,
        communicationNotes: result.reflection?.communicationNotes ?? [],
        significantEventNotes: result.reflection?.significantEventNotes ?? [],
        openLoopNotes: result.reflection?.openLoopNotes ?? [],
      }))
    `)

    assert.equal(output.reflectionSummary, 'Human context reflection')
    assert.deepEqual(output.communicationNotes, ['Prefer short check-ins while the move is in progress.'])
    assert.deepEqual(output.significantEventNotes, ['Moving to Lisbon next month.'])
    assert.deepEqual(output.openLoopNotes, ['Check in again once the move is complete.'])
  })
})
