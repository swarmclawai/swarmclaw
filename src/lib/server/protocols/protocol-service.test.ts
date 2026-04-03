import assert from 'node:assert/strict'
import test from 'node:test'
import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

test('protocol-service creates a hidden transcript run and completes a structured session', () => {
  const output = runWithTempDataDir<{
    status: string | null
    templateName: string | null
    transcriptHidden: boolean
    transcriptMessageCount: number
    artifactKinds: string[]
    summary: string | null
    eventTypes: string[]
  }>(`
    const storageMod = await import('./src/lib/server/storage')
    const protocolsMod = await import('./src/lib/server/protocols/protocol-service')
    const storage = storageMod.default || storageMod
    const protocols = protocolsMod.default || protocolsMod

    storage.upsertStoredItem('agents', 'agentA', {
      id: 'agentA',
      name: 'Agent A',
      provider: 'ollama',
      model: 'test-model',
      systemPrompt: 'test',
      createdAt: 1,
      updatedAt: 1,
    })
    storage.upsertStoredItem('agents', 'agentB', {
      id: 'agentB',
      name: 'Agent B',
      provider: 'ollama',
      model: 'test-model',
      systemPrompt: 'test',
      createdAt: 1,
      updatedAt: 1,
    })

    const run = protocols.createProtocolRun({
      title: 'Compare two approaches',
      templateId: 'review_panel',
      participantAgentIds: ['agentA', 'agentB'],
      facilitatorAgentId: 'agentA',
      autoStart: false,
      config: {
        goal: 'Compare two implementation options and conclude with a recommendation.',
        kickoffMessage: 'Focus on practical tradeoffs and the final recommendation.',
      },
    }, {
      now: () => 1000,
    })

    const completed = await protocols.runProtocolRun(run.id, {
      now: () => 2000,
      executeAgentTurn: async ({ phase, agentId }) => {
        if (phase.kind === 'collect_independent_inputs') {
          return { text: agentId === 'agentA' ? 'Option A is simpler.' : 'Option B is more flexible.', toolEvents: [] }
        }
        if (phase.kind === 'compare') {
          return { text: 'Option A is simpler while Option B is more flexible.', toolEvents: [] }
        }
        if (phase.kind === 'decide') {
          return { text: 'Choose Option A unless flexibility outweighs delivery speed.', toolEvents: [] }
        }
        if (phase.kind === 'summarize') {
          return { text: 'Recommendation: start with Option A for speed, revisit Option B later if the scope expands.', toolEvents: [] }
        }
        return { text: 'Opened the session.', toolEvents: [] }
      },
    })

    const detail = protocols.getProtocolRunDetail(run.id)

    console.log(JSON.stringify({
      status: completed?.status || null,
      templateName: detail?.run.templateName || null,
      transcriptHidden: detail?.transcript?.hidden === true,
      transcriptMessageCount: Array.isArray(detail?.transcript?.messages) ? detail.transcript.messages.length : -1,
      artifactKinds: Array.isArray(detail?.run.artifacts) ? detail.run.artifacts.map((artifact) => artifact.kind) : [],
      summary: detail?.run.summary || null,
      eventTypes: Array.isArray(detail?.events) ? detail.events.map((event) => event.type) : [],
    }))
  `, { prefix: 'swarmclaw-protocol-service-' })

  assert.equal(output.status, 'completed')
  assert.equal(output.templateName, 'Review Panel')
  assert.equal(output.transcriptHidden, true)
  assert.equal(output.transcriptMessageCount >= 5, true)
  assert.deepEqual(output.artifactKinds, ['comparison', 'decision', 'summary'])
  assert.match(String(output.summary || ''), /recommendation/i)
  assert.equal(output.eventTypes[0], 'created')
  assert.equal(output.eventTypes.includes('completed'), true)
  assert.equal(output.eventTypes.filter((type) => type === 'participant_response').length, 2)
  assert.equal(output.eventTypes.filter((type) => type === 'artifact_emitted').length, 3)
  assert.equal(output.eventTypes.filter((type) => type === 'phase_started').length, 5)
  assert.equal(output.eventTypes.filter((type) => type === 'phase_completed').length, 5)
})

test('protocol-service persists citations on participant and artifact events when grounded responses are provided', () => {
  const output = runWithTempDataDir<{
    participantCitationCounts: number[]
    artifactCitationCounts: number[]
    selectorStatuses: string[]
  }>(`
    const storageMod = await import('./src/lib/server/storage')
    const protocolsMod = await import('./src/lib/server/protocols/protocol-service')
    const storage = storageMod.default || storageMod
    const protocols = protocolsMod.default || protocolsMod

    storage.upsertStoredItem('agents', 'agentA', {
      id: 'agentA',
      name: 'Agent A',
      provider: 'ollama',
      model: 'test-model',
      systemPrompt: 'test',
      createdAt: 1,
      updatedAt: 1,
    })

    const groundedCitation = {
      sourceId: 'source-1',
      sourceTitle: 'Gateway Runbook',
      sourceKind: 'manual',
      sourceUrl: null,
      sourceLabel: null,
      chunkId: 'chunk-1',
      chunkIndex: 0,
      chunkCount: 1,
      charStart: 0,
      charEnd: 48,
      sectionLabel: null,
      snippet: 'Use blue green deployment for gateway changes.',
      whyMatched: 'Matched query terms: gateway, deployment',
      score: 0.92,
    }

    const run = protocols.createProtocolRun({
      title: 'Grounded structured run',
      templateId: 'single_agent_structured_run',
      participantAgentIds: ['agentA'],
      facilitatorAgentId: 'agentA',
      autoStart: false,
    }, { now: () => 1000 })

    await protocols.runProtocolRun(run.id, {
      now: () => 2000,
      executeAgentTurn: async ({ phase }) => {
        if (phase.kind === 'summarize') {
          return {
            text: 'Blue green deployment keeps the rollback path simple.',
            toolEvents: [],
            citations: [groundedCitation],
            retrievalTrace: {
              query: 'gateway deployment',
              scope: 'source_knowledge',
              hits: [groundedCitation],
              retrievedAt: 2000,
              selectorStatus: 'selected',
            },
          }
        }
        if (phase.kind === 'round_robin') {
          return {
            text: 'Use blue green deployment for the gateway rollout.',
            toolEvents: [],
            citations: [groundedCitation],
            retrievalTrace: {
              query: 'gateway rollout',
              scope: 'source_knowledge',
              hits: [groundedCitation],
              retrievedAt: 2000,
              selectorStatus: 'selected',
            },
          }
        }
        return { text: 'Opened the session.', toolEvents: [] }
      },
    })

    const detail = protocols.getProtocolRunDetail(run.id)
    const participantEvents = (detail?.events || []).filter((event) => event.type === 'participant_response')
    const artifactEvents = (detail?.events || []).filter((event) => event.type === 'artifact_emitted')

    console.log(JSON.stringify({
      participantCitationCounts: participantEvents.map((event) => event.citations?.length || 0),
      artifactCitationCounts: artifactEvents.map((event) => event.citations?.length || 0),
      selectorStatuses: participantEvents
        .map((event) => event.retrievalTrace?.selectorStatus)
        .filter((value) => typeof value === 'string'),
    }))
  `, { prefix: 'swarmclaw-protocol-grounding-' })

  assert.deepEqual(output.participantCitationCounts, [1])
  assert.deepEqual(output.artifactCitationCounts, [1])
  assert.deepEqual(output.selectorStatuses, [])
})

test('protocol-service supports custom template CRUD and operator actions', () => {
  const output = runWithTempDataDir<{
    createdTemplateId: string | null
    templateCount: number
    updatedName: string | null
    injectedContextCount: number
    pausedStatus: string | null
    pauseReason: string | null
    retriedStatus: string | null
    skippedPhaseIndex: number
    deleteWorked: boolean
  }>(`
    const storageMod = await import('./src/lib/server/storage')
    const protocolsMod = await import('./src/lib/server/protocols/protocol-service')
    const storage = storageMod.default || storageMod
    const protocols = protocolsMod.default || protocolsMod

    storage.upsertStoredItem('agents', 'agentA', {
      id: 'agentA',
      name: 'Agent A',
      provider: 'ollama',
      model: 'test-model',
      systemPrompt: 'test',
      createdAt: 1,
      updatedAt: 1,
    })

    const createdTemplate = protocols.createProtocolTemplate({
      name: 'Custom Compare',
      description: 'A custom comparison flow.',
      tags: ['custom', 'compare'],
      recommendedOutputs: ['summary'],
      steps: [
        { id: 'present', kind: 'present', label: 'Open', nextStepId: 'wait' },
        { id: 'wait', kind: 'wait', label: 'Wait for review' },
      ],
      entryStepId: 'present',
    })

    const updatedTemplate = protocols.updateProtocolTemplate(createdTemplate.id, {
      name: 'Custom Compare Updated',
      description: 'Updated flow.',
      tags: ['custom'],
      recommendedOutputs: ['decision'],
      steps: [
        { id: 'present', kind: 'present', label: 'Open', nextStepId: 'wait' },
        { id: 'wait', kind: 'wait', label: 'Wait for review' },
      ],
      entryStepId: 'present',
    })

    const run = protocols.createProtocolRun({
      title: 'Operator controls',
      templateId: createdTemplate.id,
      participantAgentIds: ['agentA'],
      facilitatorAgentId: 'agentA',
      autoStart: false,
    })

    protocols.performProtocolRunAction(run.id, { action: 'inject_context', context: 'Focus on the strongest tradeoff.' })
    const paused = protocols.performProtocolRunAction(run.id, { action: 'pause', reason: 'Hold for review.' })
    const retried = protocols.performProtocolRunAction(run.id, { action: 'retry_phase' })
    const skipped = protocols.performProtocolRunAction(run.id, { action: 'skip_phase' })
    const deleted = protocols.deleteProtocolTemplateById(createdTemplate.id)

    console.log(JSON.stringify({
      createdTemplateId: createdTemplate?.id || null,
      templateCount: protocols.listProtocolTemplates().filter((template) => template.id === createdTemplate.id).length,
      updatedName: updatedTemplate?.name || null,
      injectedContextCount: protocols.loadProtocolRunById(run.id)?.operatorContext?.length || 0,
      pausedStatus: paused?.status || null,
      pauseReason: paused?.pauseReason || null,
      retriedStatus: retried?.status || null,
      skippedPhaseIndex: skipped?.currentPhaseIndex ?? -1,
      deleteWorked: deleted,
    }))
  `, { prefix: 'swarmclaw-protocol-template-actions-' })

  assert.ok(output.createdTemplateId)
  assert.equal(output.templateCount, 0)
  assert.equal(output.updatedName, 'Custom Compare Updated')
  assert.equal(output.injectedContextCount, 1)
  assert.equal(output.pausedStatus, 'paused')
  assert.equal(output.pauseReason, 'Hold for review.')
  assert.equal(output.retriedStatus, 'running')
  assert.equal(output.skippedPhaseIndex >= 0, true)
  assert.equal(output.deleteWorked, true)
})

test('protocol-service supports deterministic branch steps and repeat loops', () => {
  const output = runWithTempDataDir<{
    branchStatus: string | null
    branchHistoryCount: number
    branchEventTypes: string[]
    repeatStatus: string | null
    repeatIterations: number
    repeatEventTypes: string[]
  }>(`
    const storageMod = await import('./src/lib/server/storage')
    const protocolsMod = await import('./src/lib/server/protocols/protocol-service')
    const storage = storageMod.default || storageMod
    const protocols = protocolsMod.default || protocolsMod

    storage.upsertStoredItem('agents', 'agentA', {
      id: 'agentA',
      name: 'Agent A',
      provider: 'ollama',
      model: 'test-model',
      systemPrompt: 'test',
      createdAt: 1,
      updatedAt: 1,
    })

    const branched = protocols.createProtocolRun({
      title: 'Branching run',
      participantAgentIds: ['agentA'],
      facilitatorAgentId: 'agentA',
      autoStart: false,
      steps: [
        { id: 'present', kind: 'present', label: 'Open', nextStepId: 'summarize' },
        { id: 'summarize', kind: 'summarize', label: 'Summarize', nextStepId: 'branch' },
        {
          id: 'branch',
          kind: 'branch',
          label: 'Branch',
          branchCases: [
            { id: 'has_summary', label: 'Has summary', nextStepId: 'complete', when: { type: 'summary_exists' } },
          ],
          defaultNextStepId: 'complete',
        },
        { id: 'complete', kind: 'complete', label: 'Complete' },
      ],
      entryStepId: 'present',
    })

    const branchedResult = await protocols.runProtocolRun(branched.id, {
      now: () => 1000,
      executeAgentTurn: async ({ phase }) => {
        if (phase.kind === 'summarize') return { text: 'Final structured summary.', toolEvents: [] }
        return { text: 'Opened the session.', toolEvents: [] }
      },
    })

    let repeatChecks = 0
    const repeated = protocols.createProtocolRun({
      title: 'Repeat run',
      participantAgentIds: ['agentA'],
      facilitatorAgentId: 'agentA',
      autoStart: false,
      steps: [
        {
          id: 'repeat',
          kind: 'repeat',
          label: 'Repeat worker',
          repeat: { bodyStepId: 'worker', nextStepId: 'complete', maxIterations: 4, onExhausted: 'fail' },
        },
        { id: 'worker', kind: 'present', label: 'Worker', nextStepId: 'repeat' },
        { id: 'complete', kind: 'complete', label: 'Complete' },
      ],
      entryStepId: 'repeat',
    })

    const repeatedResult = await protocols.runProtocolRun(repeated.id, {
      now: () => 2000 + repeatChecks,
      decideRepeatContinuation: async () => {
        repeatChecks += 1
        return repeatChecks >= 3 ? 'exit' : 'continue'
      },
      executeAgentTurn: async () => ({ text: 'loop body', toolEvents: [] }),
    })

    const branchDetail = protocols.getProtocolRunDetail(branched.id)
    const repeatDetail = protocols.getProtocolRunDetail(repeated.id)

    console.log(JSON.stringify({
      branchStatus: branchedResult?.status || null,
      branchHistoryCount: branchDetail?.run.branchHistory?.length || 0,
      branchEventTypes: Array.isArray(branchDetail?.events) ? branchDetail.events.map((event) => event.type) : [],
      repeatStatus: repeatedResult?.status || null,
      repeatIterations: repeatDetail?.run.loopState?.repeat?.iterationCount || 0,
      repeatEventTypes: Array.isArray(repeatDetail?.events) ? repeatDetail.events.map((event) => event.type) : [],
    }))
  `, { prefix: 'swarmclaw-protocol-steps-' })

  assert.equal(output.branchStatus, 'completed')
  assert.equal(output.branchHistoryCount, 1)
  assert.ok(output.branchEventTypes.includes('branch_taken'))
  assert.equal(output.repeatStatus, 'completed')
  assert.equal(output.repeatIterations, 2)
  assert.ok(output.repeatEventTypes.includes('loop_iteration_started'))
  assert.ok(output.repeatEventTypes.includes('loop_iteration_completed'))
})

test('protocol-service runs parallel branches, joins them, and hides system-owned child runs from the default list', () => {
  const output = runWithTempDataDir<{
    status: string | null
    visibleCount: number
    allCount: number
    childCount: number
    joinReady: boolean
    childSystemOwned: boolean
    eventTypes: string[]
    joinArtifact: string | null
  }>(`
    const storageMod = await import('./src/lib/server/storage')
    const protocolsMod = await import('./src/lib/server/protocols/protocol-service')
    const storage = storageMod.default || storageMod
    const protocols = protocolsMod.default || protocolsMod

    storage.upsertStoredItem('agents', 'agentA', {
      id: 'agentA',
      name: 'Agent A',
      provider: 'ollama',
      model: 'test-model',
      systemPrompt: 'test',
      createdAt: 1,
      updatedAt: 1,
    })
    storage.upsertStoredItem('agents', 'agentB', {
      id: 'agentB',
      name: 'Agent B',
      provider: 'ollama',
      model: 'test-model',
      systemPrompt: 'test',
      createdAt: 1,
      updatedAt: 1,
    })

    let tick = 1000
    const run = protocols.createProtocolRun({
      title: 'Parallel parent run',
      participantAgentIds: ['agentA', 'agentB'],
      facilitatorAgentId: 'agentA',
      autoStart: false,
      steps: [
        { id: 'open', kind: 'present', label: 'Open', nextStepId: 'parallel' },
        {
          id: 'parallel',
          kind: 'parallel',
          label: 'Fan out',
          nextStepId: 'join',
          parallel: {
            branches: [
              {
                id: 'alpha',
                label: 'Alpha branch',
                participantAgentIds: ['agentA'],
                steps: [
                  { id: 'alpha_open', kind: 'present', label: 'Alpha open', nextStepId: 'alpha_summary' },
                  { id: 'alpha_summary', kind: 'summarize', label: 'Alpha summary', nextStepId: 'alpha_complete' },
                  { id: 'alpha_complete', kind: 'complete', label: 'Complete' },
                ],
                entryStepId: 'alpha_open',
              },
              {
                id: 'beta',
                label: 'Beta branch',
                participantAgentIds: ['agentB'],
                steps: [
                  { id: 'beta_open', kind: 'present', label: 'Beta open', nextStepId: 'beta_summary' },
                  { id: 'beta_summary', kind: 'summarize', label: 'Beta summary', nextStepId: 'beta_complete' },
                  { id: 'beta_complete', kind: 'complete', label: 'Complete' },
                ],
                entryStepId: 'beta_open',
              },
            ],
          },
        },
        { id: 'join', kind: 'join', label: 'Join branches', join: { parallelStepId: 'parallel' }, nextStepId: 'final_summary' },
        { id: 'final_summary', kind: 'summarize', label: 'Final summary', nextStepId: 'complete' },
        { id: 'complete', kind: 'complete', label: 'Complete' },
      ],
      entryStepId: 'open',
    }, { now: () => ++tick })

    await protocols.runProtocolRun(run.id, {
      now: () => ++tick,
      executeAgentTurn: async ({ run, phase }) => {
        if (run.branchId === 'alpha' && phase.kind === 'summarize') return { text: 'Alpha result is ready.', toolEvents: [] }
        if (run.branchId === 'beta' && phase.kind === 'summarize') return { text: 'Beta result is ready.', toolEvents: [] }
        if (run.branchId) return { text: 'Branch progress update.', toolEvents: [] }
        if (phase.kind === 'summarize') return { text: 'Joined Alpha and Beta into one parent summary.', toolEvents: [] }
        return { text: 'Parent run opened.', toolEvents: [] }
      },
    })

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const latest = protocols.loadProtocolRunById(run.id)
      if (latest?.status === 'completed' || latest?.status === 'failed') break
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    const detail = protocols.getProtocolRunDetail(run.id)
    const visible = protocols.listProtocolRuns()
    const allRuns = protocols.listProtocolRuns({ includeSystemOwned: true })
    const childRuns = allRuns.filter((entry) => entry.parentRunId === run.id)
    const joinArtifact = detail?.run.artifacts?.find((artifact) => artifact.phaseId === 'join') || null

    console.log(JSON.stringify({
      status: detail?.run.status || null,
      visibleCount: visible.length,
      allCount: allRuns.length,
      childCount: childRuns.length,
      joinReady: detail?.run.parallelState?.parallel?.joinReady === true,
      childSystemOwned: childRuns.every((child) => child.systemOwned === true),
      eventTypes: Array.isArray(detail?.events) ? detail.events.map((event) => event.type) : [],
      joinArtifact: joinArtifact?.content || null,
    }))
  `, { prefix: 'swarmclaw-protocol-parallel-join-' })

  assert.equal(output.status, 'completed')
  assert.equal(output.visibleCount, 1)
  assert.equal(output.allCount, 3)
  assert.equal(output.childCount, 2)
  assert.equal(output.joinReady, true)
  assert.equal(output.childSystemOwned, true)
  assert.ok(output.eventTypes.includes('parallel_started'))
  assert.ok(output.eventTypes.includes('parallel_branch_spawned'))
  assert.ok(output.eventTypes.includes('parallel_branch_completed'))
  assert.ok(output.eventTypes.includes('join_ready'))
  assert.ok(output.eventTypes.includes('join_completed'))
  assert.match(String(output.joinArtifact || ''), /Alpha result/i)
  assert.match(String(output.joinArtifact || ''), /Beta result/i)
})

test('protocol-service fails the parent run when a joined branch fails', () => {
  const output = runWithTempDataDir<{
    status: string | null
    eventTypes: string[]
    branchStatuses: string[]
  }>(`
    const storageMod = await import('./src/lib/server/storage')
    const protocolsMod = await import('./src/lib/server/protocols/protocol-service')
    const storage = storageMod.default || storageMod
    const protocols = protocolsMod.default || protocolsMod

    storage.upsertStoredItem('agents', 'agentA', {
      id: 'agentA',
      name: 'Agent A',
      provider: 'ollama',
      model: 'test-model',
      systemPrompt: 'test',
      createdAt: 1,
      updatedAt: 1,
    })
    storage.upsertStoredItem('agents', 'agentB', {
      id: 'agentB',
      name: 'Agent B',
      provider: 'ollama',
      model: 'test-model',
      systemPrompt: 'test',
      createdAt: 1,
      updatedAt: 1,
    })

    let tick = 2000
    const run = protocols.createProtocolRun({
      title: 'Parallel failure run',
      participantAgentIds: ['agentA', 'agentB'],
      facilitatorAgentId: 'agentA',
      autoStart: false,
      steps: [
        {
          id: 'parallel',
          kind: 'parallel',
          label: 'Fan out',
          nextStepId: 'join',
          parallel: {
            branches: [
              {
                id: 'alpha',
                label: 'Alpha branch',
                participantAgentIds: ['agentA'],
                steps: [
                  { id: 'alpha_open', kind: 'round_robin', label: 'Alpha open', nextStepId: 'alpha_complete' },
                  { id: 'alpha_complete', kind: 'complete', label: 'Complete' },
                ],
                entryStepId: 'alpha_open',
              },
              {
                id: 'beta',
                label: 'Beta branch',
                participantAgentIds: ['agentB'],
                steps: [
                  { id: 'beta_open', kind: 'round_robin', label: 'Beta open', nextStepId: 'beta_complete' },
                  { id: 'beta_complete', kind: 'complete', label: 'Complete' },
                ],
                entryStepId: 'beta_open',
              },
            ],
          },
        },
        { id: 'join', kind: 'join', label: 'Join branches', join: { parallelStepId: 'parallel' }, nextStepId: 'complete' },
        { id: 'complete', kind: 'complete', label: 'Complete' },
      ],
      entryStepId: 'parallel',
    }, { now: () => ++tick })

    await protocols.runProtocolRun(run.id, {
      now: () => ++tick,
      executeAgentTurn: async ({ run }) => {
        if (run.branchId === 'beta') throw new Error('Beta branch failed.')
        return { text: 'Branch succeeded.', toolEvents: [] }
      },
    })

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const latest = protocols.loadProtocolRunById(run.id)
      if (latest?.status === 'completed' || latest?.status === 'failed') break
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    const detail = protocols.getProtocolRunDetail(run.id)
    const allRuns = protocols.listProtocolRuns({ includeSystemOwned: true })
    const childRuns = allRuns.filter((entry) => entry.parentRunId === run.id)

    console.log(JSON.stringify({
      status: detail?.run.status || null,
      eventTypes: Array.isArray(detail?.events) ? detail.events.map((event) => event.type) : [],
      branchStatuses: childRuns.map((child) => child.status),
    }))
  `, { prefix: 'swarmclaw-protocol-parallel-failure-' })

  // Phase 3A: per-agent error isolation — the beta branch's agent error is caught,
  // a warning event is emitted on the child run, and both branches complete.
  assert.equal(output.status, 'completed')
  assert.ok(output.branchStatuses.every((s: string) => s === 'completed'))
})

test('protocol-service recovers interrupted running sessions and appends a recovery event', () => {
  const output = runWithTempDataDir<{
    recoveredStatus: string | null
    recoveredEventTypes: string[]
  }>(`
    const storageMod = await import('./src/lib/server/storage')
    const protocolsMod = await import('./src/lib/server/protocols/protocol-service')
    const storage = storageMod.default || storageMod
    const protocols = protocolsMod.default || protocolsMod

    storage.upsertStoredItem('agents', 'agentA', {
      id: 'agentA',
      name: 'Agent A',
      provider: 'ollama',
      model: 'test-model',
      systemPrompt: 'test',
      createdAt: 1,
      updatedAt: 1,
    })

    const run = protocols.createProtocolRun({
      title: 'Recover me',
      templateId: 'single_agent_structured_run',
      participantAgentIds: ['agentA'],
      facilitatorAgentId: 'agentA',
      autoStart: false,
    }, { now: () => 1000 })

    storage.patchProtocolRun(run.id, (current) => current ? {
      ...current,
      status: 'running',
      startedAt: 1000,
      updatedAt: 1000,
    } : null)

    protocols.ensureProtocolEngineRecovered({
      now: () => 2000,
      executeAgentTurn: async ({ phase }) => {
        if (phase.kind === 'summarize') {
          return { text: 'Recovered summary.', toolEvents: [] }
        }
        return { text: 'Recovered turn.', toolEvents: [] }
      },
    })

    await new Promise((resolve) => setTimeout(resolve, 0))

    const detail = protocols.getProtocolRunDetail(run.id)
    console.log(JSON.stringify({
      recoveredStatus: detail?.run?.status || null,
      recoveredEventTypes: Array.isArray(detail?.events) ? detail.events.map((event) => event.type) : [],
    }))
  `, { prefix: 'swarmclaw-protocol-recovery-' })

  assert.equal(output.recoveredStatus, 'completed')
  assert.ok(output.recoveredEventTypes.includes('recovered'))
  assert.ok(output.recoveredEventTypes.includes('completed'))
})
