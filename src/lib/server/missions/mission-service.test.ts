import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

describe('mission-service', () => {
  it('creates and then completes a mission from model-backed turn decisions', () => {
    const output = runWithTempDataDir<{
      missionId: string | null
      sessionMissionId: string | null
      missionStatus: string | null
      missionPhase: string | null
      eventTypes: string[]
    }>(`
      const storageMod = await import('@/lib/server/storage')
      const missionMod = await import('@/lib/server/missions/mission-service')
      const storage = storageMod.default || storageMod['module.exports'] || storageMod
      const missions = missionMod.default || missionMod['module.exports'] || missionMod

      storage.saveSessions({
        sessionA: {
          id: 'sessionA',
          name: 'Release Chat',
          cwd: process.env.WORKSPACE_DIR,
          user: 'tester',
          provider: 'ollama',
          model: 'test-model',
          claudeSessionId: null,
          messages: [
            { role: 'user', text: 'Can you prep the release and update the docs?', time: 1 },
          ],
          createdAt: 1,
          lastActiveAt: 1,
          agentId: 'agentA',
        },
      })

      storage.saveAgents({
        agentA: {
          id: 'agentA',
          name: 'Agent A',
          provider: 'ollama',
          model: 'test-model',
          systemPrompt: 'test',
        },
      })

      const session = storage.loadSessions().sessionA
      const mission = await missions.resolveMissionForTurn({
        session,
        message: 'Please prep the release and update the docs.',
        source: 'chat',
        internal: false,
        runId: 'run-1',
        generateText: async () => JSON.stringify({
          action: 'create_new',
          confidence: 0.96,
          objective: 'Prepare the next release',
          successCriteria: ['README updated', 'release validated'],
          currentStep: 'Audit release requirements',
          plannerSummary: 'Track the release prep as a durable mission.',
        }),
      })

      const updated = await missions.applyMissionOutcomeForTurn({
        session,
        missionId: mission?.id || '',
        source: 'chat',
        runId: 'run-1',
        message: 'Please prep the release and update the docs.',
        assistantText: 'I updated the release checklist and verified the remaining steps are complete.',
        toolEvents: [],
        generateText: async () => JSON.stringify({
          verdict: 'completed',
          confidence: 0.88,
          phase: 'completed',
          verifierSummary: 'The release prep work is complete.',
        }),
      })

      const persistedSession = storage.loadSessions().sessionA
      const events = missions.listMissionEventsForMission(mission?.id || '')

      console.log(JSON.stringify({
        missionId: mission?.id || null,
        sessionMissionId: persistedSession.missionId || null,
        missionStatus: updated?.status || null,
        missionPhase: updated?.phase || null,
        eventTypes: events.map((event) => event.type),
      }))
    `, { prefix: 'swarmclaw-mission-service-' })

    assert.ok(output.missionId)
    assert.equal(output.sessionMissionId, output.missionId)
    assert.equal(output.missionStatus, 'completed')
    assert.equal(output.missionPhase, 'completed')
    assert.deepEqual(output.eventTypes, ['created', 'run_result', 'completed'])
  })

  it('reuses the current mission and records waiting state when verification says to pause', () => {
    const output = runWithTempDataDir<{
      missionId: string | null
      sameMission: boolean
      status: string | null
      waitKind: string | null
      waitReason: string | null
    }>(`
      const storageMod = await import('@/lib/server/storage')
      const missionMod = await import('@/lib/server/missions/mission-service')
      const storage = storageMod.default || storageMod['module.exports'] || storageMod
      const missions = missionMod.default || missionMod['module.exports'] || missionMod

      storage.saveSessions({
        sessionA: {
          id: 'sessionA',
          name: 'Main Chat',
          cwd: process.env.WORKSPACE_DIR,
          user: 'tester',
          provider: 'ollama',
          model: 'test-model',
          claudeSessionId: null,
          messages: [],
          createdAt: 1,
          lastActiveAt: 1,
          agentId: 'agentA',
        },
      })

      storage.saveAgents({
        agentA: {
          id: 'agentA',
          name: 'Agent A',
          provider: 'ollama',
          model: 'test-model',
          systemPrompt: 'test',
        },
      })

      const session = storage.loadSessions().sessionA
      const created = await missions.resolveMissionForTurn({
        session,
        message: 'Build the release dashboard and keep iterating on it.',
        source: 'chat',
        internal: false,
        runId: 'run-1',
        generateText: async () => JSON.stringify({
          action: 'create_new',
          confidence: 0.95,
          objective: 'Build the release dashboard',
          successCriteria: ['dashboard exists'],
          currentStep: 'Create the first dashboard draft',
        }),
      })

      const attached = await missions.resolveMissionForTurn({
        session: storage.loadSessions().sessionA,
        message: 'Now add a blocker summary section too.',
        source: 'chat',
        internal: false,
        runId: 'run-2',
        generateText: async () => JSON.stringify({
          action: 'attach_current',
          confidence: 0.89,
          currentStep: 'Add a blocker summary section',
        }),
      })

      const updated = await missions.applyMissionOutcomeForTurn({
        session: storage.loadSessions().sessionA,
        missionId: attached?.id || '',
        source: 'chat',
        runId: 'run-2',
        message: 'Now add a blocker summary section too.',
        assistantText: 'I need a design approval before I can finish the dashboard changes.',
        toolEvents: [],
        generateText: async () => JSON.stringify({
          verdict: 'waiting',
          confidence: 0.83,
          phase: 'waiting',
          currentStep: 'Wait for design approval',
          verifierSummary: 'The dashboard mission is waiting on a design approval.',
          waitKind: 'approval',
          waitReason: 'Design approval is still pending.',
        }),
      })

      console.log(JSON.stringify({
        missionId: created?.id || null,
        sameMission: created?.id === attached?.id,
        status: updated?.status || null,
        waitKind: updated?.waitState?.kind || null,
        waitReason: updated?.waitState?.reason || null,
      }))
    `, { prefix: 'swarmclaw-mission-service-' })

    assert.ok(output.missionId)
    assert.equal(output.sameMission, true)
    assert.equal(output.status, 'waiting')
    assert.equal(output.waitKind, 'approval')
    assert.equal(output.waitReason, 'Design approval is still pending.')
  })

  it('leaves unrelated one-shot turns missionless when classification says none', () => {
    const output = runWithTempDataDir<{
      resolvedMissionId: string | null
      sessionMissionId: string | null
    }>(`
      const storageMod = await import('@/lib/server/storage')
      const missionMod = await import('@/lib/server/missions/mission-service')
      const storage = storageMod.default || storageMod['module.exports'] || storageMod
      const missions = missionMod.default || missionMod['module.exports'] || missionMod

      storage.saveSessions({
        sessionA: {
          id: 'sessionA',
          name: 'Main Chat',
          cwd: process.env.WORKSPACE_DIR,
          user: 'tester',
          provider: 'ollama',
          model: 'test-model',
          claudeSessionId: null,
          messages: [],
          createdAt: 1,
          lastActiveAt: 1,
          agentId: 'agentA',
          missionId: 'missionA',
        },
      })

      storage.saveAgents({
        agentA: {
          id: 'agentA',
          name: 'Agent A',
          provider: 'ollama',
          model: 'test-model',
          systemPrompt: 'test',
        },
      })

      storage.saveMissions({
        missionA: {
          id: 'missionA',
          source: 'chat',
          sourceRef: { kind: 'chat', sessionId: 'sessionA' },
          objective: 'Long-running dashboard mission',
          status: 'active',
          phase: 'planning',
          sessionId: 'sessionA',
          agentId: 'agentA',
          taskIds: [],
          childMissionIds: [],
          dependencyMissionIds: [],
          dependencyTaskIds: [],
          currentStep: 'Wait for the next dashboard task',
          createdAt: 1,
          updatedAt: 1,
        },
      })

      const session = storage.loadSessions().sessionA
      const resolved = await missions.resolveMissionForTurn({
        session,
        message: 'Thanks',
        source: 'chat',
        internal: false,
        runId: 'run-1',
        generateText: async () => JSON.stringify({
          action: 'none',
          confidence: 0.98,
        }),
      })

      const persistedSession = storage.loadSessions().sessionA
      console.log(JSON.stringify({
        resolvedMissionId: resolved?.id || null,
        sessionMissionId: persistedSession.missionId || null,
      }))
    `, { prefix: 'swarmclaw-mission-service-' })

    assert.equal(output.resolvedMissionId, null)
    assert.equal(output.sessionMissionId, 'missionA')
  })

  it('dispatches linked backlog tasks from a mission tick', () => {
    const output = runWithTempDataDir<{
      missionId: string | null
      missionPhase: string | null
      taskStatus: string | null
      plannerDecision: string | null
    }>(`
      const storageMod = await import('@/lib/server/storage')
      const missionMod = await import('@/lib/server/missions/mission-service')
      const queueMod = await import('@/lib/server/runtime/queue')
      const storage = storageMod.default || storageMod['module.exports'] || storageMod
      const missions = missionMod.default || missionMod['module.exports'] || missionMod
      const queue = queueMod.default || queueMod['module.exports'] || queueMod

      storage.saveAgents({
        agentA: {
          id: 'agentA',
          name: 'Agent A',
          provider: 'ollama',
          model: 'test-model',
          systemPrompt: 'test',
        },
      })

      storage.saveTasks({
        taskA: {
          id: 'taskA',
          title: 'Generate release notes',
          description: 'Create the release notes artifact.',
          status: 'backlog',
          agentId: 'agentA',
          createdAt: 1,
          updatedAt: 1,
        },
      })

      const mission = missions.ensureMissionForTask(storage.loadTasks().taskA, { source: 'task' })
      const updated = await missions.runMissionTick(mission?.id || '', 'test', {
        generateText: async () => JSON.stringify({
          decision: 'dispatch_task',
          confidence: 0.96,
          summary: 'Queue the linked release notes task.',
          taskId: 'taskA',
        }),
      })
      const task = storage.loadTasks().taskA

      console.log(JSON.stringify({
        missionId: mission?.id || null,
        missionPhase: updated?.phase || null,
        taskStatus: task?.status || null,
        plannerDecision: updated?.plannerState?.lastDecision || null,
      }))
    `, { prefix: 'swarmclaw-mission-service-' })

    assert.ok(output.missionId)
    assert.equal(output.missionPhase, 'dispatching')
    assert.equal(output.taskStatus, 'queued')
    assert.equal(output.plannerDecision, 'dispatch_task')
  })

  it('marks task-backed missions completed when all linked tasks are complete', () => {
    const output = runWithTempDataDir<{
      missionStatus: string | null
      missionPhase: string | null
      lastVerdict: string | null
      eventTypes: string[]
    }>(`
      const storageMod = await import('@/lib/server/storage')
      const missionMod = await import('@/lib/server/missions/mission-service')
      const storage = storageMod.default || storageMod['module.exports'] || storageMod
      const missions = missionMod.default || missionMod['module.exports'] || missionMod

      storage.saveAgents({
        agentA: {
          id: 'agentA',
          name: 'Agent A',
          provider: 'ollama',
          model: 'test-model',
          systemPrompt: 'test',
        },
      })

      storage.saveTasks({
        taskA: {
          id: 'taskA',
          title: 'Verify the release checklist',
          description: 'Confirm the release checklist is complete.',
          status: 'completed',
          agentId: 'agentA',
          createdAt: 1,
          updatedAt: 2,
          completedAt: 2,
        },
      })

      const mission = missions.ensureMissionForTask(storage.loadTasks().taskA, { source: 'task' })
      const updated = await missions.runMissionTick(mission?.id || '', 'test')
      const events = missions.listMissionEventsForMission(mission?.id || '')

      console.log(JSON.stringify({
        missionStatus: updated?.status || null,
        missionPhase: updated?.phase || null,
        lastVerdict: updated?.verificationState?.lastVerdict || null,
        eventTypes: events.map((event) => event.type),
      }))
    `, { prefix: 'swarmclaw-mission-service-' })

    assert.equal(output.missionStatus, 'completed')
    assert.equal(output.missionPhase, 'completed')
    assert.equal(output.lastVerdict, 'completed')
    assert.deepEqual(output.eventTypes, ['created', 'task_linked', 'planner_decision', 'verifier_decision', 'completed'])
  })

  it('uses the structured planner to queue a mission follow-up turn', () => {
    const output = runWithTempDataDir<{
      missionPhase: string | null
      plannerDecision: string | null
      queuedCount: number
      queuedMissionId: string | null
      queuedText: string | null
    }>(`
      const storageMod = await import('@/lib/server/storage')
      const missionMod = await import('@/lib/server/missions/mission-service')
      const runsMod = await import('@/lib/server/runtime/session-run-manager')
      const storage = storageMod.default || storageMod['module.exports'] || storageMod
      const missions = missionMod.default || missionMod['module.exports'] || missionMod
      const runs = runsMod.default || runsMod['module.exports'] || runsMod

      storage.saveAgents({
        agentA: {
          id: 'agentA',
          name: 'Agent A',
          provider: 'ollama',
          model: 'test-model',
          systemPrompt: 'test',
        },
      })

      storage.saveSessions({
        sessionA: {
          id: 'sessionA',
          name: 'Mission Chat',
          cwd: process.env.WORKSPACE_DIR,
          user: 'tester',
          provider: 'ollama',
          model: 'test-model',
          claudeSessionId: null,
          messages: [],
          createdAt: 1,
          lastActiveAt: 1,
          agentId: 'agentA',
        },
      })

      storage.saveMissions({
        missionA: {
          id: 'missionA',
          source: 'schedule',
          sourceRef: { kind: 'schedule', scheduleId: 'sch-1', recurring: true },
          objective: 'Prepare the release handoff',
          status: 'active',
          phase: 'planning',
          sessionId: 'sessionA',
          agentId: 'agentA',
          taskIds: [],
          childMissionIds: [],
          dependencyMissionIds: [],
          dependencyTaskIds: [],
          currentStep: 'Summarize the remaining blockers',
          plannerSummary: 'Use the structured planner.',
          verifierSummary: null,
          blockerSummary: null,
          waitState: null,
          verificationState: { candidate: false },
          createdAt: 1,
          updatedAt: 1,
        },
      })

      const updated = await missions.runMissionTick('missionA', 'test', {
        generateText: async () => JSON.stringify({
          decision: 'dispatch_session_turn',
          confidence: 0.91,
          summary: 'Queue the next durable follow-up turn.',
          currentStep: 'Summarize the remaining blockers',
          sessionMessage: 'Continue the mission and summarize the remaining release blockers.',
        }),
      })
      const runList = runs.listRuns({ limit: 20 }).filter((run) => run.missionId === 'missionA')

      console.log(JSON.stringify({
        missionPhase: updated?.phase || null,
        plannerDecision: updated?.plannerState?.lastDecision || null,
        queuedCount: runList.filter((run) => run.status === 'queued' || run.status === 'running').length,
        queuedMissionId: runList[0]?.missionId || null,
        queuedText: runList[0]?.messagePreview || null,
      }))
    `, { prefix: 'swarmclaw-mission-service-' })

    assert.equal(output.missionPhase, 'dispatching')
    assert.equal(output.plannerDecision, 'dispatch_session_turn')
    assert.equal(output.queuedCount, 1)
    assert.equal(output.queuedMissionId, 'missionA')
    assert.match(output.queuedText || '', /summarize the remaining release blockers/i)
  })

  it('requests mission ticks when an approval resolves', () => {
    const output = runWithTempDataDir<{
      resumedCount: number
      missionStatus: string | null
      missionPhase: string | null
      eventTypes: string[]
    }>(`
      const storageMod = await import('@/lib/server/storage')
      const missionMod = await import('@/lib/server/missions/mission-service')
      const storage = storageMod.default || storageMod['module.exports'] || storageMod
      const missions = missionMod.default || missionMod['module.exports'] || missionMod

      storage.upsertApproval('approvalA', {
        id: 'approvalA',
        category: 'human_loop',
        title: 'Resume release mission',
        description: '',
        data: {},
        status: 'approved',
        createdAt: 1,
        updatedAt: 2,
        sessionId: 'sessionA',
      })

      storage.saveMissions({
        missionA: {
          id: 'missionA',
          source: 'chat',
          sourceRef: { kind: 'chat', sessionId: 'sessionA' },
          objective: 'Resume the release mission',
          status: 'waiting',
          phase: 'waiting',
          sessionId: 'sessionA',
          waitState: { kind: 'approval', reason: 'Waiting on approval.', approvalId: 'approvalA' },
          taskIds: [],
          createdAt: 1,
          updatedAt: 1,
        },
      })

      const resumed = missions.requestMissionTicksForApprovalDecision({
        approvalId: 'approvalA',
        status: 'approved',
        sessionId: 'sessionA',
      })
      const mission = missions.loadMissionById('missionA')
      const events = missions.listMissionEventsForMission('missionA')

      console.log(JSON.stringify({
        resumedCount: resumed.length,
        missionStatus: mission?.status || null,
        missionPhase: mission?.phase || null,
        eventTypes: events.map((event) => event.type),
      }))
    `, { prefix: 'swarmclaw-mission-service-' })

    assert.equal(output.resumedCount, 1)
    assert.equal(output.missionStatus, 'active')
    assert.equal(output.missionPhase, 'planning')
    assert.ok(output.eventTypes.includes('source_triggered'))
  })

  it('requests mission ticks when a human reply arrives', () => {
    const output = runWithTempDataDir<{
      resumedCount: number
      missionStatus: string | null
      missionPhase: string | null
    }>(`
      const storageMod = await import('@/lib/server/storage')
      const missionMod = await import('@/lib/server/missions/mission-service')
      const storage = storageMod.default || storageMod['module.exports'] || storageMod
      const missions = missionMod.default || missionMod['module.exports'] || missionMod

      storage.saveMissions({
        missionA: {
          id: 'missionA',
          source: 'connector',
          sourceRef: { kind: 'connector', sessionId: 'sessionA', connectorId: 'con-1', channelId: 'chan-1' },
          objective: 'Wait for the operator reply',
          status: 'waiting',
          phase: 'waiting',
          sessionId: 'sessionA',
          waitState: { kind: 'human_reply', reason: 'Waiting for operator reply.' },
          taskIds: [],
          createdAt: 1,
          updatedAt: 1,
        },
      })

      const resumed = missions.requestMissionTicksForHumanReply({
        sessionId: 'sessionA',
        correlationId: 'corr-1',
        payload: 'The operator replied with the final answer.',
      })
      const mission = missions.loadMissionById('missionA')

      console.log(JSON.stringify({
        resumedCount: resumed.length,
        missionStatus: mission?.status || null,
        missionPhase: mission?.phase || null,
      }))
    `, { prefix: 'swarmclaw-mission-service-' })

    assert.equal(output.resumedCount, 1)
    assert.equal(output.missionStatus, 'active')
    assert.equal(output.missionPhase, 'planning')
  })

  it('does not wake non-human waiting missions on unrelated replies', () => {
    const output = runWithTempDataDir<{
      resumedCount: number
      missionStatus: string | null
      missionPhase: string | null
      eventTypes: string[]
    }>(`
      const storageMod = await import('@/lib/server/storage')
      const missionMod = await import('@/lib/server/missions/mission-service')
      const storage = storageMod.default || storageMod['module.exports'] || storageMod
      const missions = missionMod.default || missionMod['module.exports'] || missionMod

      storage.saveMissions({
        missionA: {
          id: 'missionA',
          source: 'chat',
          sourceRef: { kind: 'chat', sessionId: 'sessionA' },
          objective: 'Wait for approval before shipping',
          status: 'waiting',
          phase: 'waiting',
          sessionId: 'sessionA',
          waitState: { kind: 'approval', reason: 'Waiting for approval.' },
          taskIds: [],
          createdAt: 1,
          updatedAt: 1,
        },
      })

      const resumed = missions.requestMissionTicksForHumanReply({
        sessionId: 'sessionA',
        correlationId: 'corr-1',
        payload: 'Here is an unrelated follow-up.',
      })
      const mission = missions.loadMissionById('missionA')
      const events = missions.listMissionEventsForMission('missionA')

      console.log(JSON.stringify({
        resumedCount: resumed.length,
        missionStatus: mission?.status || null,
        missionPhase: mission?.phase || null,
        eventTypes: events.map((event) => event.type),
      }))
    `, { prefix: 'swarmclaw-mission-service-' })

    assert.equal(output.resumedCount, 0)
    assert.equal(output.missionStatus, 'waiting')
    assert.equal(output.missionPhase, 'waiting')
    assert.equal(output.eventTypes.includes('source_triggered'), false)
  })

  it('closes mission outcomes that only wait for a human reply when mission human loop is disabled', () => {
    const output = runWithTempDataDir<{
      missionStatus: string | null
      missionPhase: string | null
      verifierSummary: string | null
      eventTypes: string[]
    }>(`
      const storageMod = await import('@/lib/server/storage')
      const missionMod = await import('@/lib/server/missions/mission-service')
      const storage = storageMod.default || storageMod['module.exports'] || storageMod
      const missions = missionMod.default || missionMod['module.exports'] || missionMod

      storage.saveSettings({ missionHumanLoopEnabled: false })
      storage.saveSessions({
        sessionA: {
          id: 'sessionA',
          name: 'Mission Chat',
          cwd: process.env.WORKSPACE_DIR,
          user: 'tester',
          provider: 'ollama',
          model: 'test-model',
          claudeSessionId: null,
          messages: [],
          createdAt: 1,
          lastActiveAt: 1,
          agentId: 'agentA',
        },
      })
      storage.saveAgents({
        agentA: {
          id: 'agentA',
          name: 'Agent A',
          provider: 'ollama',
          model: 'test-model',
          systemPrompt: 'test',
        },
      })
      storage.saveMissions({
        missionA: {
          id: 'missionA',
          source: 'chat',
          sourceRef: { kind: 'chat', sessionId: 'sessionA' },
          objective: 'Create one small file',
          status: 'active',
          phase: 'executing',
          sessionId: 'sessionA',
          agentId: 'agentA',
          taskIds: [],
          childMissionIds: [],
          dependencyMissionIds: [],
          dependencyTaskIds: [],
          currentStep: 'Write the file',
          createdAt: 1,
          updatedAt: 1,
        },
      })

      const updated = await missions.applyMissionOutcomeForTurn({
        session: storage.loadSessions().sessionA,
        missionId: 'missionA',
        source: 'chat',
        runId: 'run-1',
        message: 'Create mission.txt with start in it.',
        assistantText: 'Done. Let me know what you want next.',
        toolEvents: [],
        generateText: async () => JSON.stringify({
          verdict: 'waiting',
          confidence: 0.91,
          phase: 'waiting',
          waitKind: 'human_reply',
          waitReason: 'Waiting for the user to say what to do next.',
          verifierSummary: 'The file is done and the mission is waiting for the next instruction.',
        }),
      })
      const events = missions.listMissionEventsForMission('missionA')

      console.log(JSON.stringify({
        missionStatus: updated?.status || null,
        missionPhase: updated?.phase || null,
        verifierSummary: updated?.verifierSummary || null,
        eventTypes: events.map((event) => event.type),
      }))
    `, { prefix: 'swarmclaw-mission-service-' })

    assert.equal(output.missionStatus, 'completed')
    assert.equal(output.missionPhase, 'completed')
    assert.match(String(output.verifierSummary || ''), /human-loop waits are disabled/i)
    assert.ok(output.eventTypes.includes('completed'))
    assert.equal(output.eventTypes.includes('waiting'), false)
  })

  it('does not leave planner ticks waiting for a human reply when mission human loop is disabled', () => {
    const output = runWithTempDataDir<{
      missionStatus: string | null
      missionPhase: string | null
      plannerDecision: string | null
      lastVerdict: string | null
    }>(`
      const storageMod = await import('@/lib/server/storage')
      const missionMod = await import('@/lib/server/missions/mission-service')
      const storage = storageMod.default || storageMod['module.exports'] || storageMod
      const missions = missionMod.default || missionMod['module.exports'] || missionMod

      storage.saveSettings({ missionHumanLoopEnabled: false })
      storage.saveMissions({
        missionA: {
          id: 'missionA',
          source: 'manual',
          sourceRef: { kind: 'manual' },
          objective: 'Finish the small file task',
          status: 'active',
          phase: 'planning',
          taskIds: [],
          childMissionIds: [],
          dependencyMissionIds: [],
          dependencyTaskIds: [],
          currentStep: 'Close out the task',
          createdAt: 1,
          updatedAt: 1,
        },
      })

      const updated = await missions.runMissionTick('missionA', 'test', {
        generateText: async () => JSON.stringify({
          decision: 'wait',
          confidence: 0.88,
          summary: 'Waiting for the user to say what to do next.',
          waitKind: 'human_reply',
          waitReason: 'Waiting for the next instruction.',
        }),
      })

      console.log(JSON.stringify({
        missionStatus: updated?.status || null,
        missionPhase: updated?.phase || null,
        plannerDecision: updated?.plannerState?.lastDecision || null,
        lastVerdict: updated?.verificationState?.lastVerdict || null,
      }))
    `, { prefix: 'swarmclaw-mission-service-' })

    assert.equal(output.missionStatus, 'completed')
    assert.equal(output.missionPhase, 'completed')
    assert.equal(output.plannerDecision, 'verify_now')
    assert.equal(output.lastVerdict, 'completed')
  })

  it('requests mission ticks when provider recovery clears a provider wait', () => {
    const output = runWithTempDataDir<{
      resumedCount: number
      missionStatus: string | null
      missionPhase: string | null
    }>(`
      const missionMod = await import('@/lib/server/missions/mission-service')
      const storageMod = await import('@/lib/server/storage')
      const missions = missionMod.default || missionMod['module.exports'] || missionMod
      const storage = storageMod.default || storageMod['module.exports'] || storageMod

      storage.saveMissions({
        missionA: {
          id: 'missionA',
          source: 'chat',
          sourceRef: { kind: 'chat', sessionId: 'sessionA' },
          objective: 'Wait for provider recovery',
          status: 'waiting',
          phase: 'waiting',
          sessionId: 'sessionA',
          waitState: { kind: 'provider', reason: 'Provider connection failed.', providerKey: 'ollama' },
          taskIds: [],
          createdAt: 1,
          updatedAt: 1,
        },
      })

      const resumed = missions.requestMissionTicksForProviderRecovery('ollama')
      const mission = missions.loadMissionById('missionA')

      console.log(JSON.stringify({
        resumedCount: resumed.length,
        missionStatus: mission?.status || null,
        missionPhase: mission?.phase || null,
      }))
    `, { prefix: 'swarmclaw-mission-service-' })

    assert.equal(output.resumedCount, 1)
    assert.equal(output.missionStatus, 'active')
    assert.equal(output.missionPhase, 'planning')
  })

  it('reconciles stale executing missions on startup', () => {
    const output = runWithTempDataDir<{
      beforeStatus: string | null
      beforePhase: string | null
      missionStatus: string | null
      missionPhase: string | null
      eventTypes: string[]
    }>(`
      const storageMod = await import('@/lib/server/storage')
      const missionMod = await import('@/lib/server/missions/mission-service')
      const storage = storageMod.default || storageMod['module.exports'] || storageMod
      const missions = missionMod.default || missionMod['module.exports'] || missionMod

      storage.saveMissions({
        missionA: {
          id: 'missionA',
          source: 'chat',
          sourceRef: { kind: 'chat', sessionId: 'sessionA' },
          objective: 'Recover after restart',
          status: 'active',
          phase: 'executing',
          sessionId: 'sessionA',
          taskIds: [],
          controllerState: {
            activeRunId: 'run-stale',
            currentTaskId: 'task-stale',
          },
          createdAt: 1,
          updatedAt: 1,
        },
      })

      const before = missions.loadMissionById('missionA')
      missions.runMissionControllerStartupRecovery()
      const mission = missions.loadMissionById('missionA')
      const events = missions.listMissionEventsForMission('missionA')

      console.log(JSON.stringify({
        beforeStatus: before?.status || null,
        beforePhase: before?.phase || null,
        missionStatus: mission?.status || null,
        missionPhase: mission?.phase || null,
        eventTypes: events.map((event) => event.type),
      }))
    `, { prefix: 'swarmclaw-mission-service-' })

    assert.equal(output.beforeStatus, 'active')
    assert.equal(output.beforePhase, 'executing')
    assert.equal(output.missionStatus, 'active')
    assert.equal(output.missionPhase, 'planning')
    assert.ok(output.eventTypes.includes('interrupted'))
  })
})
