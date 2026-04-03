import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')

function runWithTempDataDir(script: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-working-state-'))
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

describe('working-state service', () => {
  it('merges deterministic evidence with structured extraction and renders a prompt block', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('@/lib/server/storage')
      const storage = storageMod.default || storageMod['module.exports'] || storageMod
      const serviceMod = await import('@/lib/server/working-state/service')
      const service = serviceMod.default || serviceMod['module.exports'] || serviceMod

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
          name: 'Main Thread',
          shortcutForAgentId: 'agent-a',
          cwd: process.cwd(),
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [
            { role: 'user', text: 'Please fix the migration and write the summary to docs/migration.md.', time: 1 },
          ],
          createdAt: 1,
          lastActiveAt: 1,
          sessionType: 'human',
          agentId: 'agent-a',
          heartbeatEnabled: true,
        },
      })

      const mission = {
        id: 'mission-1',
        source: 'chat',
        objective: 'Ship the migration fix safely.',
        successCriteria: ['docs written', 'type-check green'],
        status: 'active',
        phase: 'executing',
        currentStep: 'Run deploy after approval',
        plannerSummary: 'Fix the migration, verify it, then deploy.',
        verifierSummary: null,
        blockerSummary: null,
        createdAt: 1,
        updatedAt: 2,
      }

      const state = await service.synchronizeWorkingStateForTurn({
        sessionId: 'main',
        agentId: 'agent-a',
        mission,
        source: 'chat',
        runId: 'run-1',
        message: 'Please fix the migration and write the summary to docs/migration.md.',
        assistantText: 'I fixed the migration and wrote docs/migration.md.',
        toolEvents: [
          {
            name: 'files',
            input: JSON.stringify({ action: 'write', files: [{ path: 'docs/migration.md', content: '# migration' }] }),
            output: JSON.stringify({ ok: true, files: [{ path: 'docs/migration.md' }] }),
          },
          {
            name: 'shell',
            input: 'npm run type-check',
            output: 'Type check passed. Evidence file: /api/uploads/typecheck.txt',
          },
          {
            name: 'deploy_release',
            input: JSON.stringify({ env: 'prod' }),
            output: JSON.stringify({ requiresApproval: true, approvalId: 'apr-123' }),
          },
        ],
      }, {
        generateText: async () => JSON.stringify({
          status: 'blocked',
          nextAction: 'Wait for approval apr-123, then run the deploy step.',
          planSteps: [
            { text: 'Fix the migration build issue', status: 'resolved' },
            { text: 'Wait for approval apr-123', status: 'active' },
          ],
          factsUpsert: [
            { statement: 'Type check passed after the migration update.', source: 'tool' },
          ],
          decisionsAppend: [
            { summary: 'Capture the migration summary in docs/migration.md.', rationale: 'Keep the fix durable.' },
          ],
          blockersUpsert: [
            { summary: 'Approval apr-123 is pending.', kind: 'approval', nextAction: 'Wait for approval apr-123', status: 'active' },
          ],
          hypothesesUpsert: [
            { statement: 'After approval, deploy should be the only remaining step.', confidence: 'medium', status: 'active' },
          ],
        }),
      })

      const prompt = service.buildWorkingStatePromptBlock('main', { mission })
      console.log(JSON.stringify({
        status: state.status,
        nextAction: state.nextAction,
        planSteps: state.planSteps.map((step) => ({ text: step.text, status: step.status })),
        facts: state.confirmedFacts.map((fact) => fact.statement),
        blockers: state.blockers.map((blocker) => blocker.summary),
        artifacts: state.artifacts.map((artifact) => artifact.path || artifact.url || artifact.label),
        prompt,
      }))
    `)

    assert.equal(output.status, 'blocked')
    assert.match(String(output.nextAction), /approval apr-123/i)
    assert.ok(Array.isArray(output.planSteps) && output.planSteps.some((step) => /wait for approval apr-123/i.test(String((step as Record<string, unknown>).text))))
    assert.ok(Array.isArray(output.facts) && output.facts.some((fact) => /type check passed/i.test(String(fact))))
    assert.ok(Array.isArray(output.blockers) && output.blockers.some((blocker) => /approval apr-123 is pending/i.test(String(blocker))))
    assert.ok(Array.isArray(output.artifacts) && output.artifacts.some((artifact) => /docs\/migration\.md/i.test(String(artifact))))
    assert.match(String(output.prompt), /Active Working State/)
    assert.match(String(output.prompt), /docs\/migration\.md/)
    assert.match(String(output.prompt), /approval apr-123/i)
  })

  it('keeps the main loop hydrated from working state and mirrors main-loop updates back', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('@/lib/server/storage')
      const storage = storageMod.default || storageMod['module.exports'] || storageMod
      const mainLoopMod = await import('@/lib/server/agents/main-agent-loop')
      const mainLoop = mainLoopMod.default || mainLoopMod['module.exports'] || mainLoopMod
      const serviceMod = await import('@/lib/server/working-state/service')
      const service = serviceMod.default || serviceMod['module.exports'] || serviceMod

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
          name: 'Main Thread',
          shortcutForAgentId: 'agent-a',
          cwd: process.cwd(),
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [
            { role: 'user', text: 'Ship the release checklist.', time: 1 },
          ],
          createdAt: 1,
          lastActiveAt: 1,
          sessionType: 'human',
          agentId: 'agent-a',
          heartbeatEnabled: true,
        },
      })

      service.applyWorkingStatePatch('main', {
        objective: 'Ship the release checklist.',
        status: 'progress',
        nextAction: 'Verify the changelog output.',
        planSteps: [
          { text: 'Verify the changelog output.', status: 'active' },
          { text: 'Publish the release notes.', status: 'resolved' },
        ],
        blockersUpsert: [
          { summary: 'Waiting on release manager approval.', kind: 'approval', status: 'active' },
        ],
      })

      const before = mainLoop.getMainLoopStateForSession('main')
      const prompt = mainLoop.buildMainLoopHeartbeatPrompt(storage.loadSessions().main, 'fallback heartbeat')

      mainLoop.handleMainLoopRunResult({
        sessionId: 'main',
        message: 'Continue the release checklist.',
        internal: true,
        source: 'heartbeat',
        resultText: [
          'Updated the changelog and prepared the release notes.',
          '[AUTONOMY_TICK]{"status":"progress","summary":"Changelog verified and release notes prepared.","next_action":"publish the release notes","plan_steps":["publish the release notes"],"current_step":"publish the release notes","completed_steps":["verify the changelog output"],"review":{"note":"changelog verified","confidence":0.91,"needs_replan":false}}',
        ].join('\\n'),
        toolEvents: [{ name: 'shell', input: 'npm run type-check', output: 'ok' }],
      })

      const after = mainLoop.getMainLoopStateForSession('main')
      const working = service.loadSessionWorkingState('main')

      console.log(JSON.stringify({
        beforeNextAction: before?.nextAction || null,
        prompt,
        afterNextAction: after?.nextAction || null,
        workingNextAction: working?.nextAction || null,
        workingPlanSteps: working?.planSteps?.map((step) => ({ text: step.text, status: step.status })) || [],
      }))
    `)

    assert.match(String(output.beforeNextAction), /verify the changelog output/i)
    assert.match(String(output.prompt), /verify the changelog output/i)
    assert.match(String(output.prompt), /waiting on release manager approval/i)
    assert.match(String(output.prompt), /\[AUTONOMY_TICK\]/)
    assert.match(String(output.afterNextAction), /publish the release notes/i)
    assert.match(String(output.workingNextAction), /publish the release notes/i)
    assert.ok(Array.isArray(output.workingPlanSteps) && output.workingPlanSteps.some((step) => /publish the release notes/i.test(String((step as Record<string, unknown>).text))))
  })
})
