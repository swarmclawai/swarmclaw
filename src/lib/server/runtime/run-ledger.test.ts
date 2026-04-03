import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

test('buildRetrievalSummary preserves citation count and dedupes source ids', () => {
  const output = runWithTempDataDir<{
    empty: unknown
    summary: { citationCount: number; sourceIds: string[] } | null
  }>(`
    const ledgerMod = await import('./src/lib/server/runtime/run-ledger.ts')
    const ledger = ledgerMod.default || ledgerMod

    const summary = ledger.buildRetrievalSummary([
      { sourceId: 'source-a' },
      { sourceId: 'source-a' },
      { sourceId: 'source-b' },
    ])

    console.log(JSON.stringify({
      empty: ledger.buildRetrievalSummary([]),
      summary,
    }))
  `, { prefix: 'swarmclaw-run-ledger-summary-' })

  assert.equal(output.empty, null)
  assert.deepEqual(output.summary, {
    citationCount: 3,
    sourceIds: ['source-a', 'source-b'],
  })
})

test('appendPersistedRunEvent stores citations and retrieval traces', () => {
  const output = runWithTempDataDir<{
    eventCount: number
    citationCount: number
    selectorStatus: string | null
    sourceIds: string[]
  }>(`
    const ledgerMod = await import('./src/lib/server/runtime/run-ledger.ts')
    const storageMod = await import('./src/lib/server/storage.ts')
    const ledger = ledgerMod.default || ledgerMod
    const storage = storageMod.default || storageMod

    ledger.persistRun({
      id: 'run-grounded',
      sessionId: 'session-1',
      source: 'chat',
      internal: false,
      mode: 'followup',
      status: 'completed',
      messagePreview: 'grounded response',
      queuedAt: 1,
      retrievalSummary: null,
    })

    ledger.appendPersistedRunEvent({
      runId: 'run-grounded',
      sessionId: 'session-1',
      phase: 'status',
      status: 'completed',
      citations: [{
        sourceId: 'source-a',
        sourceTitle: 'Gateway Runbook',
        sourceKind: 'manual',
        sourceUrl: null,
        sourceLabel: null,
        chunkId: 'chunk-1',
        chunkIndex: 0,
        chunkCount: 1,
        charStart: 0,
        charEnd: 42,
        sectionLabel: null,
        snippet: 'Use blue green deployment for gateway changes.',
        whyMatched: 'Matched query terms: gateway, deployment',
        score: 0.91,
      }],
      retrievalTrace: {
        query: 'gateway deployment',
        scope: 'source_knowledge',
        hits: [{
          sourceId: 'source-a',
          sourceTitle: 'Gateway Runbook',
          sourceKind: 'manual',
          sourceUrl: null,
          sourceLabel: null,
          chunkId: 'chunk-1',
          chunkIndex: 0,
          chunkCount: 1,
          charStart: 0,
          charEnd: 42,
          sectionLabel: null,
          snippet: 'Use blue green deployment for gateway changes.',
          whyMatched: 'Matched query terms: gateway, deployment',
          score: 0.91,
        }],
        retrievedAt: 123,
        selectorStatus: 'selected',
      },
      event: {
        t: 'md',
        text: '{"run":{"status":"completed"}}',
      },
    })

    const events = Object.values(storage.loadRuntimeRunEvents())
    const stored = events[0]

    console.log(JSON.stringify({
      eventCount: events.length,
      citationCount: Array.isArray(stored?.citations) ? stored.citations.length : 0,
      selectorStatus: stored?.retrievalTrace?.selectorStatus || null,
      sourceIds: Array.isArray(stored?.citations) ? stored.citations.map((citation) => citation.sourceId) : [],
    }))
  `, { prefix: 'swarmclaw-run-ledger-events-' })

  assert.equal(output.eventCount, 1)
  assert.equal(output.citationCount, 1)
  assert.equal(output.selectorStatus, 'selected')
  assert.deepEqual(output.sourceIds, ['source-a'])
})
