import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

test('buildKnowledgeRetrievalTrace returns active hits and selectKnowledgeCitations marks empty replies as no_match', () => {
  const output = runWithTempDataDir<{
    sourceId: string | null
    hitCount: number
    firstHitSourceId: string | null
    matchedStatus: string | null
    matchedCitationCount: number
    whyMatched: string | null
    unmatchedStatus: string | null
    unmatchedCitationCount: number
  }>(`
    const knowledgeMod = await import('./src/lib/server/knowledge-sources.ts')
    const knowledge = knowledgeMod.default || knowledgeMod

    const detail = await knowledge.createKnowledgeSource({
      kind: 'manual',
      title: 'Gateway Migration Runbook',
      content: 'Use blue green deployment for gateway migrations so rollback stays simple and downtime stays low.',
      tags: ['deploy'],
    })

    const trace = await knowledge.buildKnowledgeRetrievalTrace({
      query: 'gateway blue green rollback',
    })

    const matched = knowledge.selectKnowledgeCitations({
      responseText: 'Use blue green deployment for the gateway migration so rollback stays simple.',
      retrievalTrace: trace,
    })

    const unmatched = knowledge.selectKnowledgeCitations({
      responseText: '',
      retrievalTrace: trace,
    })

    console.log(JSON.stringify({
      sourceId: detail?.source?.id || null,
      hitCount: trace?.hits?.length || 0,
      firstHitSourceId: trace?.hits?.[0]?.sourceId || null,
      matchedStatus: matched.retrievalTrace?.selectorStatus || null,
      matchedCitationCount: matched.citations.length,
      whyMatched: matched.citations[0]?.whyMatched || null,
      unmatchedStatus: unmatched.retrievalTrace?.selectorStatus || null,
      unmatchedCitationCount: unmatched.citations.length,
    }))
  `, { prefix: 'swarmclaw-knowledge-trace-' })

  assert.ok(output.sourceId)
  assert.ok(output.hitCount >= 1)
  assert.equal(output.firstHitSourceId, output.sourceId)
  assert.equal(output.matchedStatus, 'selected')
  assert.ok(output.matchedCitationCount >= 1)
  assert.match(output.whyMatched || '', /Matched|Retrieved/)
  assert.equal(output.unmatchedStatus, 'no_match')
  assert.equal(output.unmatchedCitationCount, 0)
})

test('archived and superseded sources are excluded by default, restore re-enables search, and restore actions are recorded explicitly', () => {
  const output = runWithTempDataDir<{
    archivedDefaultCount: number
    archivedIncludedCount: number
    restoredCount: number
    restoreActionKind: string | null
    supersededDefaultCount: number
    supersededIncludedCount: number
    supersededFinding: boolean
  }>(`
    const knowledgeMod = await import('./src/lib/server/knowledge-sources.ts')
    const storageMod = await import('./src/lib/server/storage.ts')
    const knowledge = knowledgeMod.default || knowledgeMod
    const storage = storageMod.default || storageMod

    const archived = await knowledge.createKnowledgeSource({
      kind: 'manual',
      title: 'Orchard Rollback Notes',
      content: 'orchard sentinel rollback checklist',
    })

    await knowledge.archiveKnowledgeSource(archived.source.id, { reason: 'manual review' })

    const archivedDefault = await knowledge.searchKnowledgeHits({ query: 'orchard' })
    const archivedIncluded = await knowledge.searchKnowledgeHits({
      query: 'orchard',
      includeArchived: true,
    })

    await knowledge.restoreKnowledgeSource(archived.source.id)
    const restored = await knowledge.searchKnowledgeHits({ query: 'orchard' })

    const older = await knowledge.createKnowledgeSource({
      kind: 'manual',
      title: 'Legacy API Notes',
      content: 'legacy endpoint alpha is still enabled',
      sourceUrl: 'https://example.com/api/reference',
    })
    const newer = await knowledge.createKnowledgeSource({
      kind: 'manual',
      title: 'Current API Notes',
      content: 'modern endpoint beta replaced the older route',
      sourceUrl: 'https://example.com/api/reference',
    })

    storage.patchKnowledgeSource(older.source.id, (current) => current ? {
      ...current,
      lastIndexedAt: 1_000,
      updatedAt: 1_000,
    } : null)
    storage.patchKnowledgeSource(newer.source.id, (current) => current ? {
      ...current,
      lastIndexedAt: 2_000,
      updatedAt: 2_000,
    } : null)

    await knowledge.runKnowledgeHygieneMaintenance()

    const supersededDefault = await knowledge.searchKnowledgeHits({ query: 'alpha' })
    const supersededIncluded = await knowledge.searchKnowledgeHits({
      query: 'alpha',
      includeArchived: true,
    })
    const summary = await knowledge.getKnowledgeHygieneSummary()

    console.log(JSON.stringify({
      archivedDefaultCount: archivedDefault.length,
      archivedIncludedCount: archivedIncluded.length,
      restoredCount: restored.length,
      restoreActionKind: summary.recentActions.find((action) => action.summary === 'Restored Orchard Rollback Notes')?.kind || null,
      supersededDefaultCount: supersededDefault.length,
      supersededIncludedCount: supersededIncluded.length,
      supersededFinding: summary.findings.some((finding) => finding.kind === 'superseded' && finding.sourceId === older.source.id),
    }))
  `, { prefix: 'swarmclaw-knowledge-lifecycle-' })

  assert.equal(output.archivedDefaultCount, 0)
  assert.equal(output.archivedIncludedCount, 1)
  assert.equal(output.restoredCount, 1)
  assert.equal(output.restoreActionKind, 'restore')
  assert.equal(output.supersededDefaultCount, 0)
  assert.equal(output.supersededIncludedCount, 1)
  assert.equal(output.supersededFinding, true)
})

test('runKnowledgeHygieneMaintenance reindexes stale file sources and archives exact duplicates', () => {
  const output = runWithTempDataDir<{
    fileLastAutoSyncAt: number | null
    fileChunksContainUpdatedText: boolean
    refreshedHitCount: number
    archivedDuplicateCount: number
    recentActionKinds: string[]
  }>(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const knowledgeMod = await import('./src/lib/server/knowledge-sources.ts')
    const storageMod = await import('./src/lib/server/storage.ts')
    const knowledge = knowledgeMod.default || knowledgeMod
    const storage = storageMod.default || storageMod

    const filePath = path.join(process.env.WORKSPACE_DIR, 'ops-runbook.txt')
    fs.writeFileSync(filePath, 'Initial runbook placeholder.')

    const fileSource = await knowledge.createKnowledgeSource({
      kind: 'file',
      title: 'Ops Runbook',
      sourcePath: filePath,
    })

    fs.writeFileSync(filePath, 'Updated runbook adds rollback choreography and incident checklist.')
    storage.patchKnowledgeSource(fileSource.source.id, (current) => current ? {
      ...current,
      lastIndexedAt: 1,
      nextSyncAt: 1,
      updatedAt: 1,
    } : null)

    const duplicateA = await knowledge.createKnowledgeSource({
      kind: 'manual',
      title: 'Duplicate A',
      content: 'duplicate payload for archival',
    })
    const duplicateB = await knowledge.createKnowledgeSource({
      kind: 'manual',
      title: 'Duplicate B',
      content: 'duplicate payload for archival',
    })

    const summary = await knowledge.runKnowledgeHygieneMaintenance()
    const refreshed = await knowledge.getKnowledgeSourceDetail(fileSource.source.id)
    const duplicateADetail = await knowledge.getKnowledgeSourceDetail(duplicateA.source.id)
    const duplicateBDetail = await knowledge.getKnowledgeSourceDetail(duplicateB.source.id)
    const refreshedHits = await knowledge.searchKnowledgeHits({ query: 'choreography' })

    const archivedDuplicateCount = [duplicateADetail, duplicateBDetail]
      .filter((detail) => !!detail?.source?.archivedAt)
      .length

    console.log(JSON.stringify({
      fileLastAutoSyncAt: refreshed?.source?.lastAutoSyncAt || null,
      fileChunksContainUpdatedText: (refreshed?.chunks || []).some((chunk) => chunk.content.includes('rollback choreography')),
      refreshedHitCount: refreshedHits.length,
      archivedDuplicateCount,
      recentActionKinds: summary.recentActions.map((action) => action.kind),
    }))
  `, { prefix: 'swarmclaw-knowledge-maintenance-' })

  assert.ok(typeof output.fileLastAutoSyncAt === 'number' && output.fileLastAutoSyncAt > 0)
  assert.equal(output.fileChunksContainUpdatedText, true)
  assert.ok(output.refreshedHitCount >= 1)
  assert.equal(output.archivedDuplicateCount, 1)
  assert.ok(output.recentActionKinds.includes('archive'))
  assert.ok(output.recentActionKinds.includes('reindex') || output.recentActionKinds.includes('sync'))
})
