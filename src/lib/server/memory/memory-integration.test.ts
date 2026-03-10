import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Session } from '@/types'

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
}

let tempDir = ''
let memDb: ReturnType<Awaited<typeof import('@/lib/server/memory/memory-db')>['getMemoryDb']>
let executeMemoryAction: Awaited<typeof import('@/lib/server/session-tools/memory')>['executeMemoryAction']
let memoryPolicy: typeof import('@/lib/server/memory/memory-policy')

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-memory-int-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  process.env.SWARMCLAW_BUILD_MODE = '1'
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true })
  fs.mkdirSync(process.env.WORKSPACE_DIR, { recursive: true })

  const memDbMod = await import('@/lib/server/memory/memory-db')
  memDb = memDbMod.getMemoryDb()

  const memoryMod = await import('@/lib/server/session-tools/memory')
  executeMemoryAction = memoryMod.executeMemoryAction

  memoryPolicy = await import('@/lib/server/memory/memory-policy')
})

after(() => {
  if (originalEnv.DATA_DIR === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = originalEnv.DATA_DIR
  if (originalEnv.WORKSPACE_DIR === undefined) delete process.env.WORKSPACE_DIR
  else process.env.WORKSPACE_DIR = originalEnv.WORKSPACE_DIR
  if (originalEnv.SWARMCLAW_BUILD_MODE === undefined) delete process.env.SWARMCLAW_BUILD_MODE
  else process.env.SWARMCLAW_BUILD_MODE = originalEnv.SWARMCLAW_BUILD_MODE
  fs.rmSync(tempDir, { recursive: true, force: true })
})

// ─── Memory CRUD Lifecycle ──────────────────────────────────────────

describe('Memory CRUD lifecycle via executeMemoryAction', () => {
  let storedId = ''

  it('stores a memory and returns confirmation', async () => {
    const result = await executeMemoryAction(
      { action: 'store', key: 'test-crud', value: 'CRUD content', category: 'note' },
      { agentId: 'agent-crud' },
    )
    assert.match(String(result), /Stored memory/)
    const idMatch = String(result).match(/\(id: ([^)]+)\)/)
    assert.ok(idMatch, 'result should contain an id')
    storedId = idMatch[1]
  })

  it('gets the stored memory by id', async () => {
    const result = await executeMemoryAction(
      { action: 'get', id: storedId },
      { agentId: 'agent-crud' },
    )
    assert.match(String(result), /test-crud/)
    assert.match(String(result), /CRUD content/)
  })

  it('searches for the memory by query', async () => {
    const result = await executeMemoryAction(
      { action: 'search', query: 'CRUD content' },
      { agentId: 'agent-crud' },
    )
    assert.match(String(result), /CRUD content/)
  })

  it('lists all memories and includes it', async () => {
    const result = await executeMemoryAction(
      { action: 'list' },
      { agentId: 'agent-crud' },
    )
    assert.match(String(result), /test-crud/)
  })

  it('updates title and content', async () => {
    const result = await executeMemoryAction(
      { action: 'update', id: storedId, title: 'updated-title', value: 'updated-content' },
      { agentId: 'agent-crud' },
    )
    assert.match(String(result), /Updated memory/)
    assert.match(String(result), /updated-title/)
  })

  it('deletes and confirms gone', async () => {
    const deleteResult = await executeMemoryAction(
      { action: 'delete', id: storedId },
      { agentId: 'agent-crud' },
    )
    assert.match(String(deleteResult), /Deleted/)
    const getResult = await executeMemoryAction(
      { action: 'get', id: storedId },
      { agentId: 'agent-crud' },
    )
    assert.match(String(getResult), /not found|access denied/i)
  })

  it('falls back to the latest user fact when store omits value', async () => {
    const sessionContext: Partial<Session> = {
      id: 'session-implicit',
      name: 'Implicit store',
      agentId: 'agent-crud',
      messages: [
        { role: 'user', text: 'Remember this exactly: Project Kodiak uses amber-fox and the freeze date is April 21, 2026.', time: Date.now() },
      ],
    }
    const result = await executeMemoryAction(
      { action: 'store', key: 'implicit-fact-store' },
      sessionContext,
    )
    assert.match(String(result), /Stored memory/)

    const search = await executeMemoryAction(
      { action: 'search', query: 'amber-fox April 21 2026' },
      { agentId: 'agent-crud' },
    )
    assert.match(String(search), /April 21, 2026/)
    assert.match(String(search), /amber-fox/)
  })
})

// ─── Memory Linking & Graph ─────────────────────────────────────────

describe('Memory linking and graph', () => {
  let idA = ''
  let idB = ''
  let idC = ''

  before(async () => {
    const a = memDb.add({ agentId: 'agent-link', category: 'note', title: 'Node A', content: 'alpha unique content' })
    const b = memDb.add({ agentId: 'agent-link', category: 'note', title: 'Node B', content: 'beta unique content' })
    const c = memDb.add({ agentId: 'agent-link', category: 'note', title: 'Node C', content: 'gamma unique content' })
    idA = a.id
    idB = b.id
    idC = c.id
  })

  it('links A→B and B→C with bidirectional links', () => {
    memDb.link(idA, [idB], true)
    memDb.link(idB, [idC], true)

    const a = memDb.get(idA)!
    const b = memDb.get(idB)!
    const c = memDb.get(idC)!

    assert.ok(a.linkedMemoryIds?.includes(idB), 'A should link to B')
    assert.ok(b.linkedMemoryIds?.includes(idA), 'B should link back to A')
    assert.ok(b.linkedMemoryIds?.includes(idC), 'B should link to C')
    assert.ok(c.linkedMemoryIds?.includes(idB), 'C should link back to B')
  })

  it('unlinks A→B bidirectionally', () => {
    memDb.unlink(idA, [idB], true)

    const a = memDb.get(idA)!
    const b = memDb.get(idB)!

    const aLinks = a.linkedMemoryIds || []
    const bLinks = b.linkedMemoryIds || []
    assert.ok(!aLinks.includes(idB), 'A should no longer link to B')
    assert.ok(!bLinks.includes(idA), 'B should no longer link to A')
    // B↔C should still exist
    assert.ok(bLinks.includes(idC), 'B should still link to C')
  })

  it('deleting C cleans up B linkedMemoryIds', () => {
    memDb.delete(idC)
    const b = memDb.get(idB)!
    const bLinks = b.linkedMemoryIds || []
    assert.ok(!bLinks.includes(idC), 'B should no longer reference deleted C')
  })
})

// ─── Scope Filtering ────────────────────────────────────────────────

describe('Scope filtering', () => {
  before(() => {
    memDb.add({ agentId: 'agent-a', category: 'note', title: 'A-only', content: 'scope test agent a' })
    memDb.add({ agentId: 'agent-b', category: 'note', title: 'B-only', content: 'scope test agent b' })
    memDb.add({ agentId: null, category: 'note', title: 'Shared global', content: 'scope test global' })
    memDb.add({ agentId: 'agent-c', category: 'note', title: 'Shared with B', content: 'scope shared with b', sharedWith: ['agent-b'] })
  })

  it('agent scope shows only that agent memories', async () => {
    const result = await executeMemoryAction(
      { action: 'list', scope: 'agent' },
      { agentId: 'agent-a' },
    )
    assert.match(String(result), /A-only/)
    assert.doesNotMatch(String(result), /B-only/)
  })

  it('global scope shows only shared memories (no agentId)', async () => {
    const result = await executeMemoryAction(
      { action: 'list', scope: 'global' },
      { agentId: 'agent-a' },
    )
    assert.match(String(result), /Shared global/)
    assert.doesNotMatch(String(result), /A-only/)
  })

  it('sharedWith memories visible to target agent in agent scope', async () => {
    const result = await executeMemoryAction(
      { action: 'list', scope: 'agent' },
      { agentId: 'agent-b' },
    )
    assert.match(String(result), /Shared with B/)
  })
})

describe('Search source filtering', () => {
  before(() => {
    memDb.add({
      agentId: 'agent-source-filter',
      category: 'projects/decisions',
      title: 'Kodiak durable fact',
      content: 'Project Kodiak uses amber-fox and the freeze date is April 21, 2026.',
    })
    memDb.add({
      agentId: 'agent-source-filter',
      sessionId: 'archive-session-1',
      category: 'session_archive',
      title: 'Session archive: kodiak stale',
      content: 'Transcript excerpt: Project Kodiak freeze date was April 18, 2026.',
      metadata: { tier: 'archive' },
    })
    memDb.add({
      agentId: 'agent-source-filter',
      category: 'operations/execution',
      title: 'Auto execution note',
      content: 'assistant_outcome: during a previous run I mentioned April 18, 2026 while fixing Project Kodiak memory.',
    })
  })

  it('search defaults to durable memories', async () => {
    const result = await executeMemoryAction(
      { action: 'search', query: 'Project Kodiak amber-fox freeze date' },
      { agentId: 'agent-source-filter', sessionId: 'agent-source-filter', messages: [] },
    )
    assert.match(String(result), /Kodiak durable fact/)
    assert.doesNotMatch(String(result), /Session archive: kodiak stale/)
    assert.doesNotMatch(String(result), /Auto execution note/)
  })

  it('search can explicitly include archives and working memories', async () => {
    const archiveResult = await executeMemoryAction(
      { action: 'search', query: 'Project Kodiak freeze date', sources: ['durable', 'archive', 'working'] },
      { agentId: 'agent-source-filter', sessionId: 'archive-session-1', messages: [] },
    )
    assert.match(String(archiveResult), /Kodiak durable fact/)
    assert.match(String(archiveResult), /Session archive: kodiak stale/)

    const workingResult = await executeMemoryAction(
      { action: 'search', query: 'assistant_outcome previous run April 18, 2026', sources: ['working'] },
      { agentId: 'agent-source-filter', sessionId: 'archive-session-1', messages: [] },
    )
    assert.match(String(workingResult), /Auto execution note/)
  })
})

describe('Canonical memory correction', () => {
  it('update without an explicit id resolves and corrects the canonical durable memory', async () => {
    const stale = memDb.add({
      agentId: 'agent-canonical',
      category: 'projects/decisions',
      title: 'Project Kodiak codename and freeze date',
      content: 'Project Kodiak uses the codename "amber-fox" and the freeze date is April 18, 2026.',
    })
    memDb.add({
      agentId: 'agent-canonical',
      category: 'note',
      title: '[auto-consolidated] Project Kodiak note',
      content: 'Stored earlier: Project Kodiak codename amber-fox freeze date April 18, 2026.',
    })

    const result = await executeMemoryAction(
      {
        action: 'update',
        title: 'Project Kodiak freeze date correction',
        value: 'Project Kodiak uses the codename "amber-fox" and the freeze date is April 21, 2026.',
      },
      { agentId: 'agent-canonical', sessionId: 'agent-canonical', messages: [] },
    )

    assert.match(String(result), /Updated memory/)
    const corrected = memDb.get(stale.id)
    assert.ok(corrected)
    assert.match(String(corrected?.content), /April 21, 2026/)

    const recall = await executeMemoryAction(
      { action: 'search', query: 'Project Kodiak amber-fox freeze date' },
      { agentId: 'agent-canonical', sessionId: 'agent-canonical', messages: [] },
    )
    assert.match(String(recall), /April 21, 2026/)
    assert.doesNotMatch(String(recall), /auto-consolidated/i)
  })

  it('store merges into an existing canonical durable memory instead of appending a conflicting duplicate', async () => {
    const base = memDb.add({
      agentId: 'agent-canonical-store',
      category: 'projects/context',
      title: 'Project Kodiak details',
      content: 'Project Kodiak: codename amber-fox, freeze date April 18 2026',
    })

    const result = await executeMemoryAction(
      {
        action: 'store',
        title: 'Project Kodiak details',
        value: 'Project Kodiak: codename amber-fox, freeze date April 21 2026',
        category: 'projects/context',
      },
      { agentId: 'agent-canonical-store', sessionId: 'agent-canonical-store', messages: [] },
    )

    assert.match(String(result), /updating the canonical entry/i)
    const updated = memDb.get(base.id)
    assert.ok(updated)
    assert.match(String(updated?.content), /April 21 2026/)

    const durableRows = memDb.list('agent-canonical-store', 20)
      .filter((entry) => /Project Kodiak/.test(`${entry.title} ${entry.content}`))
      .filter((entry) => entry.category !== 'session_archive')
    assert.equal(durableRows.filter((entry) => entry.id === base.id).length, 1)
  })

  it('parses structured JSON payloads that arrive inside query or value fields', async () => {
    const base = memDb.add({
      agentId: 'agent-structured-payload',
      category: 'projects/decisions',
      title: 'Project Kodiak codename and freeze date',
      content: 'Project Kodiak uses the codename "amber-fox" and the freeze date is April 18, 2026.',
    })

    const result = await executeMemoryAction(
      {
        action: 'update',
        query: JSON.stringify({
          title: 'Project Kodiak codename and freeze date',
          category: 'projects/decisions',
          content: 'Project Kodiak uses the codename "amber-fox" and the freeze date is April 21, 2026.',
        }),
      },
      { agentId: 'agent-structured-payload', sessionId: 'agent-structured-payload', messages: [] },
    )

    assert.match(String(result), /Updated memory/)
    const updated = memDb.get(base.id)
    assert.ok(updated)
    assert.match(String(updated?.content), /April 21, 2026/)
    assert.doesNotMatch(String(updated?.content), /"title"/)
  })
})

// ─── Pinned Memories ────────────────────────────────────────────────

describe('Pinned memories', () => {
  before(() => {
    memDb.add({ agentId: 'agent-pin', category: 'note', title: 'Normal 1', content: 'not pinned one', pinned: false })
    memDb.add({ agentId: 'agent-pin', category: 'note', title: 'Normal 2', content: 'not pinned two', pinned: false })
    memDb.add({ agentId: 'agent-pin', category: 'note', title: 'Normal 3', content: 'not pinned three', pinned: false })
    memDb.add({ agentId: 'agent-pin', category: 'note', title: 'Pinned 1', content: 'pinned content one', pinned: true })
    memDb.add({ agentId: 'agent-pin', category: 'note', title: 'Pinned 2', content: 'pinned content two', pinned: true })
  })

  it('listPinned returns only pinned memories', () => {
    const pinned = memDb.listPinned('agent-pin')
    assert.ok(pinned.length >= 2, `expected at least 2 pinned, got ${pinned.length}`)
    for (const entry of pinned) {
      assert.ok(entry.pinned, `entry "${entry.title}" should be pinned`)
    }
  })
})

// ─── Category Normalization ─────────────────────────────────────────

describe('Category normalization (comprehensive)', () => {
  const norm = (cat: string, title?: string, content?: string) =>
    memoryPolicy.normalizeMemoryCategory(cat, title ?? null, content ?? null)

  it('maps flat categories to hierarchical', () => {
    assert.equal(norm('preference'), 'identity/preferences')
    assert.equal(norm('decision'), 'projects/decisions')
    assert.equal(norm('error'), 'execution/errors')
    assert.equal(norm('project'), 'projects/context')
    assert.equal(norm('learning'), 'projects/learnings')
    assert.equal(norm('breadcrumb'), 'operations/execution')
    assert.equal(norm('fact'), 'knowledge/facts')
    assert.equal(norm('working'), 'working/scratch')
  })

  it('infers category from content when explicit is "note"', () => {
    assert.equal(norm('note', 'user prefers dark mode', ''), 'identity/preferences')
    assert.equal(norm('note', 'decided to ship Docker', ''), 'projects/decisions')
    assert.equal(norm('note', 'root cause was a null pointer', ''), 'projects/learnings')
  })

  it('passes through already-hierarchical categories', () => {
    assert.equal(norm('identity/profile'), 'identity/profile')
    assert.equal(norm('custom/bucket'), 'custom/bucket')
  })
})

// ─── Memory Doctor Report ───────────────────────────────────────────

describe('Memory doctor report', () => {
  it('builds report with correct counts', () => {
    const entries = [
      { id: '1', agentId: 'a', category: 'identity/preferences', title: '', content: '', pinned: true, linkedMemoryIds: ['2'], createdAt: 0, updatedAt: 0 },
      { id: '2', agentId: 'a', category: 'projects/decisions', title: '', content: '', pinned: false, linkedMemoryIds: ['1'], sharedWith: ['b'], createdAt: 0, updatedAt: 0 },
      { id: '3', agentId: 'a', category: 'knowledge/facts', title: '', content: '', pinned: true, createdAt: 0, updatedAt: 0 },
      { id: '4', agentId: null, category: 'operations/execution', title: '', content: '', pinned: false, sharedWith: ['a'], createdAt: 0, updatedAt: 0 },
    ] as unknown as import('@/types').MemoryEntry[]

    const report = memoryPolicy.buildMemoryDoctorReport(entries, 'a')
    assert.match(report, /Visible memories: 4/)
    assert.match(report, /Pinned: 2/)
    assert.match(report, /Linked: 2/)
    assert.match(report, /Shared: 2/)
    assert.match(report, /identity/)
    assert.match(report, /projects/)
    assert.match(report, /knowledge/)
    assert.match(report, /operations/)
  })
})

// ─── Auto-capture Policy ────────────────────────────────────────────

describe('Auto-capture policy', () => {
  it('shouldInjectMemoryContext: short ack → false', () => {
    assert.equal(memoryPolicy.shouldInjectMemoryContext('ok'), false)
  })

  it('shouldInjectMemoryContext: greeting → false', () => {
    assert.equal(memoryPolicy.shouldInjectMemoryContext('hello'), false)
  })

  it('shouldInjectMemoryContext: short memory meta → false', () => {
    assert.equal(memoryPolicy.shouldInjectMemoryContext('remember this'), false)
  })

  it('shouldInjectMemoryContext: substantive message → true', () => {
    assert.equal(
      memoryPolicy.shouldInjectMemoryContext('Compare the current deployment plan with what we decided yesterday'),
      true,
    )
  })

  it('shouldAutoCaptureMemoryTurn: short messages → false', () => {
    assert.equal(memoryPolicy.shouldAutoCaptureMemoryTurn('hi', 'hello!'), false)
  })

  it('shouldAutoCaptureMemoryTurn: ack + response → false', () => {
    assert.equal(
      memoryPolicy.shouldAutoCaptureMemoryTurn('thanks', 'You are welcome, happy to help with that!'),
      false,
    )
  })

  it('shouldAutoCaptureMemoryTurn: error response → false', () => {
    assert.equal(
      memoryPolicy.shouldAutoCaptureMemoryTurn(
        'Please deploy the production environment now with all the settings',
        "sorry, I can't do that because I don't have the credentials needed.",
      ),
      false,
    )
  })

  it('shouldAutoCaptureMemoryTurn: substantive exchange → true', () => {
    assert.equal(
      memoryPolicy.shouldAutoCaptureMemoryTurn(
        'We decided to use the shared staging environment and keep the worker count at 2 for now.',
        'Decision captured: shared staging, worker count 2, and we will revisit after load testing next week.',
      ),
      true,
    )
  })

  it('shouldAutoCaptureMemoryTurn: HEARTBEAT_OK response → false', () => {
    assert.equal(
      memoryPolicy.shouldAutoCaptureMemoryTurn(
        'This is a real substantive question about the project and architecture',
        'HEARTBEAT_OK all systems nominal',
      ),
      false,
    )
  })
})

// ─── inferAutomaticMemoryCategory ───────────────────────────────────

describe('inferAutomaticMemoryCategory', () => {
  it('infers identity/preferences from preference-like content', () => {
    assert.equal(
      memoryPolicy.inferAutomaticMemoryCategory('user prefers dark mode', 'noted'),
      'identity/preferences',
    )
  })

  it('infers projects/decisions from decision-like content', () => {
    assert.equal(
      memoryPolicy.inferAutomaticMemoryCategory('decided to ship Docker first', 'locked in'),
      'projects/decisions',
    )
  })

  it('infers projects/learnings from learning-like content', () => {
    assert.equal(
      memoryPolicy.inferAutomaticMemoryCategory('root cause was a null pointer bug', 'fixed now'),
      'projects/learnings',
    )
  })
})

// ─── Memory Deduplication ───────────────────────────────────────────

describe('Memory deduplication via contentHash', () => {
  it('storing same content twice reinforces instead of duplicating', () => {
    const first = memDb.add({ agentId: 'agent-dedup', category: 'note', title: 'Dup test', content: 'exact duplicate content for dedup test' })
    const second = memDb.add({ agentId: 'agent-dedup', category: 'note', title: 'Dup test', content: 'exact duplicate content for dedup test' })
    assert.equal(first.id, second.id, 'second add should return same id')
    assert.ok((second.reinforcementCount ?? 0) >= 1, 'reinforcement count should be bumped')
  })
})

// ─── Unknown Action ─────────────────────────────────────────────────

describe('Unknown action', () => {
  it('returns unknown action message', async () => {
    const result = await executeMemoryAction({ action: 'invalid' }, null)
    assert.match(String(result), /Unknown action/)
  })
})

// ─── Edge Cases ─────────────────────────────────────────────────────

describe('Edge cases', () => {
  it('store with empty value is rejected when no fallback fact exists', async () => {
    const result = await executeMemoryAction(
      { action: 'store', key: 'empty-val', value: '', category: 'note' },
      { agentId: 'agent-edge' },
    )
    assert.match(String(result), /requires a non-empty value/i)
  })

  it('store with missing key defaults title to Untitled', async () => {
    const result = await executeMemoryAction(
      { action: 'store', value: 'some content without key', category: 'note' },
      { agentId: 'agent-edge' },
    )
    assert.match(String(result), /Stored memory/)
    assert.match(String(result), /Untitled/)
  })

  it('store with null context still works', async () => {
    const result = await executeMemoryAction(
      { action: 'store', key: 'null-ctx', value: 'null context test', category: 'note' },
      null,
    )
    assert.match(String(result), /Stored memory/)
  })

  it('store with imagePath that does not exist still stores', async () => {
    const result = await executeMemoryAction(
      { action: 'store', key: 'no-image', value: 'image missing', category: 'note', imagePath: '/tmp/nonexistent-image.png' },
      { agentId: 'agent-edge' },
    )
    assert.match(String(result), /Stored memory/)
  })

  it('update non-existent memory → not found', async () => {
    const result = await executeMemoryAction(
      { action: 'update', id: 'nonexistent-id-xyz', value: 'updated' },
      { agentId: 'agent-edge' },
    )
    assert.match(String(result), /not found/i)
  })

  it('get with non-existent id → not found', async () => {
    const result = await executeMemoryAction(
      { action: 'get', id: 'missing-id-abc' },
      { agentId: 'agent-edge' },
    )
    assert.match(String(result), /not found/i)
  })

  it('link requires targetIds', async () => {
    const entry = memDb.add({ agentId: 'agent-edge', category: 'note', title: 'Link test', content: 'link target test' })
    const result = await executeMemoryAction(
      { action: 'link', id: entry.id },
      { agentId: 'agent-edge' },
    )
    assert.match(String(result), /requires targetIds/i)
  })

  it('unlink requires targetIds', async () => {
    const entry = memDb.add({ agentId: 'agent-edge', category: 'note', title: 'Unlink test', content: 'unlink target test' })
    const result = await executeMemoryAction(
      { action: 'unlink', id: entry.id },
      { agentId: 'agent-edge' },
    )
    assert.match(String(result), /requires targetIds/i)
  })

  it('delete non-existent memory → not found', async () => {
    const result = await executeMemoryAction(
      { action: 'delete', id: 'phantom-id-999' },
      { agentId: 'agent-edge' },
    )
    assert.match(String(result), /not found/i)
  })
})

// ─── Doctor via executeMemoryAction ─────────────────────────────────

describe('Doctor action via executeMemoryAction', () => {
  it('returns a doctor report', async () => {
    const result = await executeMemoryAction(
      { action: 'doctor' },
      { agentId: 'agent-crud' },
    )
    assert.match(String(result), /Memory Doctor/)
    assert.match(String(result), /Visible memories/)
  })
})

// ─── Direct memDb CRUD ──────────────────────────────────────────────

describe('Direct memDb CRUD', () => {
  it('add, get, update, delete cycle', () => {
    const entry = memDb.add({ agentId: 'direct-agent', category: 'note', title: 'Direct test', content: 'direct content' })
    assert.ok(entry.id)
    assert.equal(entry.title, 'Direct test')

    const fetched = memDb.get(entry.id)
    assert.ok(fetched)
    assert.equal(fetched.content, 'direct content')

    const updated = memDb.update(entry.id, { title: 'Updated direct', content: 'updated direct content' })
    assert.ok(updated)
    assert.equal(updated.title, 'Updated direct')

    memDb.delete(entry.id)
    const gone = memDb.get(entry.id)
    assert.equal(gone, null)
  })

  it('list returns entries and respects updatedAt ordering', () => {
    const a = memDb.add({ agentId: 'list-agent', category: 'note', title: 'First', content: 'first entry for list test' })
    const b = memDb.add({ agentId: 'list-agent', category: 'note', title: 'Second', content: 'second entry for list test' })
    const entries = memDb.list('list-agent', 10)
    assert.ok(entries.length >= 2, 'should list at least 2 entries')
    assert.ok(entries.some((e) => e.id === a.id), 'should include entry a')
    assert.ok(entries.some((e) => e.id === b.id), 'should include entry b')
    // Verify entries are sorted by updatedAt descending (ties allowed)
    for (let i = 1; i < entries.length; i++) {
      assert.ok(entries[i - 1].updatedAt >= entries[i].updatedAt, 'list should be ordered by updatedAt desc')
    }
  })

  it('search via FTS finds matching entries', () => {
    memDb.add({ agentId: 'search-agent', category: 'note', title: 'Kubernetes deployment', content: 'helm chart configuration for kubernetes cluster' })
    const results = memDb.search('kubernetes helm chart', 'search-agent')
    assert.ok(results.length >= 1, 'FTS should find the kubernetes entry')
    assert.ok(results.some((r) => r.title === 'Kubernetes deployment'))
  })

  it('update returns null for non-existent id', () => {
    const result = memDb.update('missing-xyz', { title: 'no' })
    assert.equal(result, null)
  })
})

// ─── Link and Unlink via executeMemoryAction ────────────────────────

describe('Link and unlink via executeMemoryAction', () => {
  let id1 = ''
  let id2 = ''

  before(() => {
    const entry1 = memDb.add({ agentId: 'agent-act-link', category: 'note', title: 'Link A', content: 'link action A' })
    const entry2 = memDb.add({ agentId: 'agent-act-link', category: 'note', title: 'Link B', content: 'link action B' })
    id1 = entry1.id
    id2 = entry2.id
  })

  it('links memories via action', async () => {
    const result = await executeMemoryAction(
      { action: 'link', id: id1, targetIds: [id2] },
      { agentId: 'agent-act-link' },
    )
    assert.match(String(result), /Linked/)
    const entry = memDb.get(id1)!
    assert.ok(entry.linkedMemoryIds?.includes(id2))
  })

  it('unlinks memories via action', async () => {
    const result = await executeMemoryAction(
      { action: 'unlink', id: id1, targetIds: [id2] },
      { agentId: 'agent-act-link' },
    )
    assert.match(String(result), /Unlinked/)
    const entry = memDb.get(id1)!
    const links = entry.linkedMemoryIds || []
    assert.ok(!links.includes(id2))
  })
})
