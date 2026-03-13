import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'

import { stripMainLoopMetaForPersistence } from '@/lib/server/agents/main-agent-loop'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')

function runWithTempDataDir(script: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-loop-adv-'))
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
        timeout: 15000,
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

/** Shared setup script that creates one agent and one heartbeat-enabled main session */
function sessionSetupScript(sessionOverrides?: string, extraSessions?: string): string {
  return `
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
        name: 'Main Thread',
        shortcutForAgentId: 'agent-a',
        cwd: process.cwd(),
        user: 'tester',
        provider: 'openai',
        model: 'gpt-test',
        claudeSessionId: null,
        messages: [
          { role: 'user', text: 'Deploy the system.', time: 1 },
        ],
        createdAt: 1,
        lastActiveAt: 1,
        sessionType: 'human',
        agentId: 'agent-a',
        heartbeatEnabled: true,
        ${sessionOverrides || ''}
      },
      ${extraSessions || ''}
    })
  `
}

function heartbeatMetaLine(status: string, goal: string, nextAction?: string, extraFields?: string): string {
  const parts = [`"status":"${status}","goal":"${goal}"`]
  if (nextAction) parts.push(`"next_action":"${nextAction}"`)
  if (extraFields) parts.push(extraFields)
  return `[AGENT_HEARTBEAT_META]{${parts.join(',')}}`
}

function makeRunResultCall(
  index: number,
  resultText: string,
  opts?: { error?: string; inputTokens?: number; outputTokens?: number; estimatedCost?: number; source?: string },
): string {
  const errorPart = opts?.error ? `error: '${opts.error}',` : ''
  const inputTokens = opts?.inputTokens ?? 10
  const outputTokens = opts?.outputTokens ?? 5
  const estimatedCost = opts?.estimatedCost ?? 0
  const source = opts?.source ?? 'heartbeat'
  return `
    const followup${index} = mainLoop.handleMainLoopRunResult({
      sessionId: 'main',
      message: 'Continue objective step ${index}.',
      internal: true,
      source: '${source}',
      resultText: \`${resultText}\`,
      ${errorPart}
      inputTokens: ${inputTokens},
      outputTokens: ${outputTokens},
      estimatedCost: ${estimatedCost},
    })
    const state${index} = mainLoop.getMainLoopStateForSession('main')
  `
}

describe('main-agent-loop advanced', () => {
  // ─────────────────────────────────────────────────────────────────────
  // 1. Followup chain escalation and cap
  // ─────────────────────────────────────────────────────────────────────
  it('followup chain escalates then resets at DEFAULT_MAX_FOLLOWUP_CHAIN=3', () => {
    const meta = heartbeatMetaLine('progress', 'deploy', 'continue')
    const output = runWithTempDataDir(`
      ${sessionSetupScript()}

      ${makeRunResultCall(1, `Working on deployment.\\n${meta}`)}
      ${makeRunResultCall(2, `Still deploying.\\n${meta}`)}
      ${makeRunResultCall(3, `Almost done.\\n${meta}`)}
      ${makeRunResultCall(4, `Finishing up.\\n${meta}`)}
      ${makeRunResultCall(5, `Final polish.\\n${meta}`)}

      console.log(JSON.stringify({
        chain1: state1?.followupChainCount ?? -1,
        chain2: state2?.followupChainCount ?? -1,
        chain3: state3?.followupChainCount ?? -1,
        chain4: state4?.followupChainCount ?? -1,
        chain5: state5?.followupChainCount ?? -1,
        hasFollowup1: followup1 !== null,
        hasFollowup2: followup2 !== null,
        hasFollowup3: followup3 !== null,
        hasFollowup4: followup4 !== null,
        hasFollowup5: followup5 !== null,
      }))
    `)

    // Chain increments 0→1→2→3, then at 3 the condition (3 < 3) is false → resets to 0
    // Call 5 starts from 0 again → increments to 1
    assert.equal(output.chain1, 1, 'first call increments to 1')
    assert.equal(output.chain2, 2, 'second call increments to 2')
    assert.equal(output.chain3, 3, 'third call increments to 3 (the cap)')
    assert.equal(output.chain4, 0, 'fourth call resets to 0 because cap was reached')
    assert.equal(output.chain5, 1, 'fifth call increments from 0 to 1 again')
    assert.equal(output.hasFollowup1, true, 'followup returned for call 1')
    assert.equal(output.hasFollowup2, true, 'followup returned for call 2')
    assert.equal(output.hasFollowup3, true, 'followup returned for call 3')
    assert.equal(output.hasFollowup4, false, 'no followup at cap boundary')
    assert.equal(output.hasFollowup5, true, 'followup resumes after reset')
  })

  // ─────────────────────────────────────────────────────────────────────
  // 2. Chain reset on terminal status (ok / HEARTBEAT_OK)
  // ─────────────────────────────────────────────────────────────────────
  it('followup chain resets to 0 on terminal ok status', () => {
    const progressMeta = heartbeatMetaLine('progress', 'deploy', 'keep going')
    const output = runWithTempDataDir(`
      ${sessionSetupScript()}

      ${makeRunResultCall(1, `Step one.\\n${progressMeta}`)}
      ${makeRunResultCall(2, `Step two.\\n${progressMeta}`)}

      // Now send a terminal ack
      const followupOk = mainLoop.handleMainLoopRunResult({
        sessionId: 'main',
        message: 'Continue.',
        internal: true,
        source: 'heartbeat',
        resultText: 'HEARTBEAT_OK',
      })
      const stateOk = mainLoop.getMainLoopStateForSession('main')

      console.log(JSON.stringify({
        chainBefore1: state1?.followupChainCount ?? -1,
        chainBefore2: state2?.followupChainCount ?? -1,
        chainAfterOk: stateOk?.followupChainCount ?? -1,
        statusAfterOk: stateOk?.status ?? null,
        followupOk: followupOk,
      }))
    `)

    assert.equal(output.chainBefore1, 1)
    assert.equal(output.chainBefore2, 2)
    assert.equal(output.chainAfterOk, 0, 'chain resets on HEARTBEAT_OK')
    assert.equal(output.statusAfterOk, 'ok', 'status becomes ok')
    assert.equal(output.followupOk, null, 'no followup on terminal ack')
  })

  it('allows a bounded followup for chat-originated runs when structured progress is still active', () => {
    const progressMeta = heartbeatMetaLine('progress', 'buy nft', 'prepare the first safe wallet step')
    const output = runWithTempDataDir(`
      ${sessionSetupScript()}

      const followup = mainLoop.handleMainLoopRunResult({
        sessionId: 'main',
        message: 'Try buy one NFT and show me what happened.',
        internal: false,
        source: 'chat',
        resultText: \`I found the contract and I am moving to the first safe execution step.\\n${progressMeta}\`,
        toolEvents: [{
          name: 'wallet_tool',
          input: '{"action":"balance"}',
          output: '{"status":"ok"}',
        }],
      })
      const state = mainLoop.getMainLoopStateForSession('main')

      console.log(JSON.stringify({
        hasFollowup: followup !== null,
        followupMessage: followup?.message ?? null,
        chain: state?.followupChainCount ?? -1,
        status: state?.status ?? null,
        nextAction: state?.nextAction ?? null,
      }))
    `)

    assert.equal(output.hasFollowup, true, 'chat run should queue one bounded followup')
    assert.equal(output.chain, 1, 'chat followup starts the chain at 1')
    assert.equal(output.status, 'progress')
    assert.equal(output.nextAction, 'prepare the first safe wallet step')
    assert.match(String(output.followupMessage || ''), /Resume from this next action/)
  })

  it('uses the supervisor followup prompt when chat runs start thrashing on the same tool', () => {
    const output = runWithTempDataDir(`
      ${sessionSetupScript()}

      const followup = mainLoop.handleMainLoopRunResult({
        runId: 'run-supervisor',
        sessionId: 'main',
        message: 'Fix the broken deployment pipeline.',
        internal: false,
        source: 'chat',
        resultText: 'Retried the same shell path several times and got the same failure.',
        toolEvents: [
          { name: 'shell', input: '{"cmd":"npm test"}' },
          { name: 'shell', input: '{"cmd":"npm test"}' },
          { name: 'shell', input: '{"cmd":"npm test"}' },
        ],
      })
      const state = mainLoop.getMainLoopStateForSession('main')

      console.log(JSON.stringify({
        hasFollowup: followup !== null,
        followupMessage: followup?.message ?? null,
        chain: state?.followupChainCount ?? -1,
        timelineSources: (state?.timeline || []).map((entry) => entry.source),
        timelineNotes: (state?.timeline || []).map((entry) => entry.note),
      }))
    `)

    assert.equal(output.hasFollowup, true, 'supervisor should queue a recovery followup')
    assert.equal(output.chain, 1, 'supervisor followup increments the chain')
    assert.match(String(output.followupMessage || ''), /Supervisor intervention: stop repeating shell/i)
    assert.ok((output.timelineSources as string[]).includes('supervisor'), 'supervisor interventions should be visible in timeline')
    assert.ok((output.timelineNotes as string[]).some((note) => /Repeated tool use detected/i.test(String(note))), 'timeline should explain the supervisor trigger')
  })

  it('persists and upgrades a skill blocker across recommend/install steps', () => {
    const output = runWithTempDataDir(`
      ${sessionSetupScript()}

      mainLoop.handleMainLoopRunResult({
        sessionId: 'main',
        message: 'Continue the Google Workspace automation.',
        internal: true,
        source: 'heartbeat',
        resultText: 'Blocked: missing capability for Google Workspace CLI in this environment.',
      })
      const state1 = mainLoop.getMainLoopStateForSession('main')

      mainLoop.handleMainLoopRunResult({
        sessionId: 'main',
        message: 'Continue the Google Workspace automation.',
        internal: true,
        source: 'heartbeat',
        resultText: 'Checked local skills.',
        toolEvents: [{
          name: 'manage_skills',
          input: JSON.stringify({ action: 'recommend_for_task', task: 'Google Workspace automation' }),
          output: JSON.stringify({ local: [{ name: 'google-workspace', status: 'needs_install' }] }),
        }],
      })
      const state2 = mainLoop.getMainLoopStateForSession('main')

      mainLoop.handleMainLoopRunResult({
        sessionId: 'main',
        message: 'Continue the Google Workspace automation.',
        internal: true,
        source: 'heartbeat',
        resultText: 'Install approval requested.',
        toolEvents: [{
          name: 'manage_skills',
          input: JSON.stringify({ action: 'install', name: 'google-workspace' }),
          output: JSON.stringify({
            requiresApproval: true,
            approval: { id: 'appr-123' },
            skill: { name: 'google-workspace' },
          }),
        }],
      })
      const state3 = mainLoop.getMainLoopStateForSession('main')

      const heartbeatPrompt = mainLoop.buildMainLoopHeartbeatPrompt({
        id: 'main',
        shortcutForAgentId: 'agent-a',
        agentId: 'agent-a',
        heartbeatEnabled: true,
        messages: [{ role: 'user', text: 'Deploy the system.', time: 1 }],
      }, 'Base prompt')

      console.log(JSON.stringify({
        firstStatus: state1?.skillBlocker?.status ?? null,
        firstSummary: state1?.skillBlocker?.summary ?? null,
        secondStatus: state2?.skillBlocker?.status ?? null,
        secondCandidates: state2?.skillBlocker?.candidateSkills ?? [],
        secondAttempts: state2?.skillBlocker?.attempts ?? -1,
        thirdStatus: state3?.skillBlocker?.status ?? null,
        thirdApprovalId: state3?.skillBlocker?.approvalId ?? null,
        promptHasSkillBlocker: heartbeatPrompt.includes('Active skill blocker:'),
        promptHasApproval: heartbeatPrompt.includes('Pending approval: appr-123'),
      }))
    `)

    assert.equal(output.firstStatus, 'new')
    assert.match(String(output.firstSummary), /missing capability/i)
    assert.equal(output.secondStatus, 'recommended')
    assert.deepEqual(output.secondCandidates, ['google-workspace'])
    assert.equal(output.secondAttempts, 1)
    assert.equal(output.thirdStatus, 'approval_requested')
    assert.equal(output.thirdApprovalId, 'appr-123')
    assert.equal(output.promptHasSkillBlocker, true)
    assert.equal(output.promptHasApproval, true)
  })

  it('resets metadata miss count when structured metadata returns and keeps terminal acks at zero', () => {
    const meta = heartbeatMetaLine('progress', 'deploy', 'continue')
    const output = runWithTempDataDir(`
      ${sessionSetupScript()}

      const miss1 = mainLoop.handleMainLoopRunResult({
        sessionId: 'main',
        message: 'Continue objective.',
        internal: true,
        source: 'heartbeat',
        resultText: 'Still working without structured metadata.',
      })
      const state1 = mainLoop.getMainLoopStateForSession('main')

      const miss2 = mainLoop.handleMainLoopRunResult({
        sessionId: 'main',
        message: 'Continue objective.',
        internal: true,
        source: 'heartbeat',
        resultText: 'Another plain-text update without metadata.',
      })
      const state2 = mainLoop.getMainLoopStateForSession('main')

      const withMeta = mainLoop.handleMainLoopRunResult({
        sessionId: 'main',
        message: 'Continue objective.',
        internal: true,
        source: 'heartbeat',
        resultText: \`Metadata restored.\\n${meta}\`,
      })
      const state3 = mainLoop.getMainLoopStateForSession('main')

      const terminalAck = mainLoop.handleMainLoopRunResult({
        sessionId: 'main',
        message: 'Continue objective.',
        internal: true,
        source: 'heartbeat',
        resultText: 'HEARTBEAT_OK',
      })
      const state4 = mainLoop.getMainLoopStateForSession('main')

      console.log(JSON.stringify({
        followupMiss1: miss1,
        followupMiss2: miss2,
        followupWithMeta: withMeta,
        followupTerminalAck: terminalAck,
        missCount1: state1?.metaMissCount ?? -1,
        missCount2: state2?.metaMissCount ?? -1,
        missCount3: state3?.metaMissCount ?? -1,
        missCount4: state4?.metaMissCount ?? -1,
        statusAfterAck: state4?.status ?? null,
      }))
    `)

    assert.equal(output.missCount1, 1)
    assert.equal(output.missCount2, 2)
    assert.equal(output.missCount3, 0, 'structured metadata resets the miss counter')
    assert.equal(output.missCount4, 0, 'terminal ack should not count as a metadata miss')
    assert.equal(output.statusAfterAck, 'ok')
    assert.equal(output.followupTerminalAck, null)
  })

  // ─────────────────────────────────────────────────────────────────────
  // 3. Chain reset on error
  // ─────────────────────────────────────────────────────────────────────
  it('followup chain resets to 0 when error is present', () => {
    const progressMeta = heartbeatMetaLine('progress', 'deploy', 'next step')
    const output = runWithTempDataDir(`
      ${sessionSetupScript()}

      ${makeRunResultCall(1, `Working.\\n${progressMeta}`)}
      ${makeRunResultCall(2, `More work.\\n${progressMeta}`)}

      // Send error result
      ${makeRunResultCall(3, 'Something broke.', { error: 'Connection timeout' })}

      console.log(JSON.stringify({
        chain1: state1?.followupChainCount ?? -1,
        chain2: state2?.followupChainCount ?? -1,
        chain3: state3?.followupChainCount ?? -1,
        status3: state3?.status ?? null,
        followup3: followup3,
      }))
    `)

    assert.equal(output.chain1, 1)
    assert.equal(output.chain2, 2)
    assert.equal(output.chain3, 0, 'chain resets on error')
    assert.equal(output.status3, 'blocked', 'status becomes blocked on error')
    assert.equal(output.followup3, null, 'no followup on error')
  })

  // ─────────────────────────────────────────────────────────────────────
  // 4. Event fan-out to main sessions only
  // ─────────────────────────────────────────────────────────────────────
  it('pushMainLoopEventToMainSessions only targets heartbeat-enabled sessions', () => {
    const output = runWithTempDataDir(`
      ${sessionSetupScript(
        '',
        `'non-hb': {
          id: 'non-hb',
          name: 'Non-HB Thread',
          cwd: process.cwd(),
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [{ role: 'user', text: 'Hello.', time: 1 }],
          createdAt: 1,
          lastActiveAt: 1,
          sessionType: 'human',
          agentId: 'agent-a',
          heartbeatEnabled: false,
        },`
      )}

      const count = mainLoop.pushMainLoopEventToMainSessions({
        type: 'task_completed',
        text: 'Deployment finished',
      })

      const mainState = mainLoop.getMainLoopStateForSession('main')
      const nonHbState = mainLoop.getMainLoopStateForSession('non-hb')

      console.log(JSON.stringify({
        count,
        mainPendingCount: mainState?.pendingEvents?.length ?? 0,
        mainEventText: mainState?.pendingEvents?.[0]?.text ?? null,
        nonHbState: nonHbState,
      }))
    `)

    assert.equal(output.count, 1, 'only 1 session received the event')
    assert.equal(output.mainPendingCount, 1, 'heartbeat-enabled session got the event')
    assert.equal(output.mainEventText, 'Deployment finished')
    assert.equal(output.nonHbState, null, 'non-heartbeat session has no state')
  })

  // ─────────────────────────────────────────────────────────────────────
  // 5. Pending events cap at MAX_PENDING_EVENTS=16
  // ─────────────────────────────────────────────────────────────────────
  it('caps pending events at 16, keeping the most recent', () => {
    const output = runWithTempDataDir(`
      ${sessionSetupScript()}

      for (let i = 0; i < 20; i++) {
        mainLoop.pushMainLoopEventToMainSessions({
          type: 'update',
          text: 'Event number ' + i,
        })
      }

      const state = mainLoop.getMainLoopStateForSession('main')
      const firstEventText = state?.pendingEvents?.[0]?.text ?? null
      const lastEventText = state?.pendingEvents?.[state.pendingEvents.length - 1]?.text ?? null

      console.log(JSON.stringify({
        pendingCount: state?.pendingEvents?.length ?? 0,
        firstEventText,
        lastEventText,
      }))
    `)

    assert.equal(output.pendingCount, 16, 'capped at 16')
    // The oldest events (0-3) should have been dropped; the most recent 16 (4-19) remain
    assert.equal(output.firstEventText, 'Event number 4', 'oldest events are dropped')
    assert.equal(output.lastEventText, 'Event number 19', 'newest events are kept')
  })

  // ─────────────────────────────────────────────────────────────────────
  // 6. Timeline accumulation and cap at MAX_TIMELINE_ITEMS=40
  // ─────────────────────────────────────────────────────────────────────
  it('accumulates timeline entries with correct source/status and caps at 40', () => {
    const output = runWithTempDataDir(`
      ${sessionSetupScript()}

      // Push enough run results to exceed the timeline cap.
      // Each handleMainLoopRunResult with substantive text appends at least 1 timeline entry.
      // With followup chaining, each also appends a 'followup' timeline entry → ~2 per call.
      // We need >40 entries total, so 25 calls should exceed 40.
      const chainCounts = []
      for (let i = 0; i < 25; i++) {
        const meta = '[AGENT_HEARTBEAT_META]{"status":"progress","goal":"timeline test","next_action":"step ' + i + '"}'
        mainLoop.handleMainLoopRunResult({
          sessionId: 'main',
          message: 'Continue timeline test ' + i + '.',
          internal: true,
          source: 'heartbeat',
          resultText: 'Completed step ' + i + '.\\n' + meta,
          inputTokens: 5,
          outputTokens: 3,
        })
        const s = mainLoop.getMainLoopStateForSession('main')
        chainCounts.push(s?.followupChainCount ?? -1)
      }

      const finalState = mainLoop.getMainLoopStateForSession('main')
      const timelineLength = finalState?.timeline?.length ?? 0
      const sources = [...new Set((finalState?.timeline || []).map(e => e.source))]
      const hasProgressStatus = (finalState?.timeline || []).some(e => e.status === 'progress')

      console.log(JSON.stringify({
        timelineLength,
        cappedAt40: timelineLength <= 40,
        sources,
        hasProgressStatus,
        firstNote: finalState?.timeline?.[0]?.note ?? null,
        lastNote: finalState?.timeline?.[timelineLength - 1]?.note ?? null,
      }))
    `)

    assert.ok((output.timelineLength as number) > 0, 'timeline has entries')
    assert.equal(output.cappedAt40, true, 'timeline is capped at 40')
    assert.ok(
      (output.sources as string[]).includes('heartbeat') || (output.sources as string[]).includes('followup'),
      'timeline has expected source values',
    )
    assert.equal(output.hasProgressStatus, true, 'timeline includes progress status entries')
  })

  // ─────────────────────────────────────────────────────────────────────
  // 7. Working memory notes from tool events
  // ─────────────────────────────────────────────────────────────────────
  it('appends working memory notes when tool events are present', () => {
    const output = runWithTempDataDir(`
      ${sessionSetupScript()}

      const meta = '[AGENT_HEARTBEAT_META]{"status":"progress","goal":"research","next_action":"analyze"}'
      mainLoop.handleMainLoopRunResult({
        sessionId: 'main',
        message: 'Research step.',
        internal: true,
        source: 'heartbeat',
        resultText: 'Found important data.\\n' + meta,
        toolEvents: [
          { name: 'web_search', input: '{"query":"important finding about X"}' },
          { name: 'shell', input: '{"action":"execute","command":"ls"}' },
        ],
        inputTokens: 20,
        outputTokens: 10,
      })

      const state = mainLoop.getMainLoopStateForSession('main')

      console.log(JSON.stringify({
        workingMemoryNotes: state?.workingMemoryNotes ?? [],
        hasToolNote: (state?.workingMemoryNotes ?? []).some(n => n.includes('web_search') || n.includes('shell')),
        lastMemoryNoteAt: state?.lastMemoryNoteAt !== null,
      }))
    `)

    assert.ok((output.workingMemoryNotes as string[]).length > 0, 'working memory has notes')
    assert.equal(output.hasToolNote, true, 'working memory includes tool names')
    assert.equal(output.lastMemoryNoteAt, true, 'lastMemoryNoteAt is set')
  })

  // ─────────────────────────────────────────────────────────────────────
  // 8. Meta strip for persistence (direct import — no subprocess needed)
  // ─────────────────────────────────────────────────────────────────────
  it('stripMainLoopMetaForPersistence removes meta lines and preserves regular text', () => {
    const input = [
      'Here is a normal analysis of the system.',
      '[AGENT_HEARTBEAT_META]{"status":"progress","goal":"test"}',
      'Another regular line with findings.',
      '[MAIN_LOOP_PLAN]{"steps":["step1","step2"],"current_step":"step1"}',
      'Final observation about performance.',
      '[MAIN_LOOP_REVIEW]{"note":"reviewed","confidence":0.8,"needs_replan":false}',
    ].join('\n')

    const result = stripMainLoopMetaForPersistence(input)

    assert.ok(!result.includes('[AGENT_HEARTBEAT_META]'), 'heartbeat meta removed')
    assert.ok(!result.includes('[MAIN_LOOP_PLAN]'), 'plan meta removed')
    assert.ok(!result.includes('[MAIN_LOOP_REVIEW]'), 'review meta removed')
    assert.ok(result.includes('Here is a normal analysis of the system.'), 'first regular line preserved')
    assert.ok(result.includes('Another regular line with findings.'), 'second regular line preserved')
    assert.ok(result.includes('Final observation about performance.'), 'third regular line preserved')
  })

  it('stripMainLoopMetaForPersistence handles text with no meta lines', () => {
    const input = 'Just a simple message with no meta.'
    const result = stripMainLoopMetaForPersistence(input)
    assert.equal(result, input)
  })

  it('stripMainLoopMetaForPersistence handles text that is only meta', () => {
    const input = '[AGENT_HEARTBEAT_META]{"status":"ok","goal":"done"}'
    const result = stripMainLoopMetaForPersistence(input)
    assert.equal(result, '')
  })

  // ─────────────────────────────────────────────────────────────────────
  // 9. Status transitions (direct import via subprocess for state access)
  // ─────────────────────────────────────────────────────────────────────
  it('preserves all valid status values: idle, progress, blocked, ok', () => {
    const output = runWithTempDataDir(`
      ${sessionSetupScript()}

      const statuses = ['idle', 'progress', 'blocked', 'ok']
      const results = {}

      for (const status of statuses) {
        const meta = '[AGENT_HEARTBEAT_META]{"status":"' + status + '","goal":"status test ' + status + '"}'
        // For terminal statuses we need non-internal source to avoid chain logic
        // Actually internal + heartbeat source + no error works for progress/blocked/idle
        // For 'ok' status without HEARTBEAT_OK text, it should preserve the status
        mainLoop.handleMainLoopRunResult({
          sessionId: 'main',
          message: 'Testing status ' + status + '.',
          internal: true,
          source: 'heartbeat',
          resultText: 'Status is ' + status + '.\\n' + meta,
          inputTokens: 5,
          outputTokens: 3,
        })
        const s = mainLoop.getMainLoopStateForSession('main')
        results[status] = s?.status ?? null
      }

      console.log(JSON.stringify({ results }))
    `)

    const results = output.results as Record<string, string>
    assert.equal(results.idle, 'idle', 'idle status preserved')
    assert.equal(results.progress, 'progress', 'progress status preserved')
    assert.equal(results.blocked, 'blocked', 'blocked status preserved')
    assert.equal(results.ok, 'ok', 'ok status preserved')
  })

  // ─────────────────────────────────────────────────────────────────────
  // 10. Mission cost accumulation
  // ─────────────────────────────────────────────────────────────────────
  it('accumulates missionCostUsd and missionTokens across multiple runs', () => {
    const output = runWithTempDataDir(`
      ${sessionSetupScript()}

      const meta1 = '[AGENT_HEARTBEAT_META]{"status":"progress","goal":"cost test","next_action":"step 1"}'
      const meta2 = '[AGENT_HEARTBEAT_META]{"status":"progress","goal":"cost test","next_action":"step 2"}'
      const meta3 = '[AGENT_HEARTBEAT_META]{"status":"progress","goal":"cost test","next_action":"step 3"}'

      mainLoop.handleMainLoopRunResult({
        sessionId: 'main',
        message: 'Cost step 1.',
        internal: true,
        source: 'heartbeat',
        resultText: 'Step 1 complete.\\n' + meta1,
        inputTokens: 100,
        outputTokens: 50,
        estimatedCost: 0.05,
      })
      const s1 = mainLoop.getMainLoopStateForSession('main')

      mainLoop.handleMainLoopRunResult({
        sessionId: 'main',
        message: 'Cost step 2.',
        internal: true,
        source: 'heartbeat',
        resultText: 'Step 2 complete.\\n' + meta2,
        inputTokens: 200,
        outputTokens: 100,
        estimatedCost: 0.10,
      })
      const s2 = mainLoop.getMainLoopStateForSession('main')

      mainLoop.handleMainLoopRunResult({
        sessionId: 'main',
        message: 'Cost step 3.',
        internal: true,
        source: 'heartbeat',
        resultText: 'Step 3 complete.\\n' + meta3,
        inputTokens: 300,
        outputTokens: 150,
        estimatedCost: 0.15,
      })
      const s3 = mainLoop.getMainLoopStateForSession('main')

      console.log(JSON.stringify({
        cost1: s1?.missionCostUsd ?? -1,
        cost2: s2?.missionCostUsd ?? -1,
        cost3: s3?.missionCostUsd ?? -1,
        tokens1: s1?.missionTokens ?? -1,
        tokens2: s2?.missionTokens ?? -1,
        tokens3: s3?.missionTokens ?? -1,
      }))
    `)

    assert.ok(
      Math.abs((output.cost1 as number) - 0.05) < 0.001,
      `cost after step 1 should be ~0.05, got ${output.cost1}`,
    )
    assert.ok(
      Math.abs((output.cost2 as number) - 0.15) < 0.001,
      `cost after step 2 should be ~0.15, got ${output.cost2}`,
    )
    assert.ok(
      Math.abs((output.cost3 as number) - 0.30) < 0.001,
      `cost after step 3 should be ~0.30, got ${output.cost3}`,
    )
    assert.equal(output.tokens1, 150, 'tokens after step 1: 100+50=150')
    assert.equal(output.tokens2, 450, 'tokens after step 2: 150+200+100=450')
    assert.equal(output.tokens3, 900, 'tokens after step 3: 450+300+150=900')
  })
})
