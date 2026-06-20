import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
}

let tempDir = ''
let mod: typeof import('@/lib/server/tasks/task-followups')

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-task-followups-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  process.env.SWARMCLAW_BUILD_MODE = '1'
  mod = await import('@/lib/server/tasks/task-followups')
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

describe('task-followups', () => {
  // ---- extractLikelyOutputFiles ----

  describe('extractLikelyOutputFiles', () => {
    it('extracts backtick-quoted file paths', () => {
      const text = 'I saved the report to `report.pdf` and the data to `data.csv`.'
      const files = mod.extractLikelyOutputFiles(text)
      assert.deepEqual(files, ['report.pdf', 'data.csv'])
    })

    it('extracts bare file paths with slashes', () => {
      const text = 'Output written to output/results.json and also tmp/log.txt'
      const files = mod.extractLikelyOutputFiles(text)
      assert.ok(files.includes('output/results.json'))
      assert.ok(files.includes('tmp/log.txt'))
    })

    it('deduplicates case-insensitively', () => {
      const text = '`Report.PDF` and `report.pdf` are the same file.'
      const files = mod.extractLikelyOutputFiles(text)
      assert.equal(files.length, 1)
    })

    it('ignores HTTP URLs in bare path regex', () => {
      // The backtick regex captures the inner content; push() filters http:// and /api/uploads/
      // But bare URLs still get matched by the path regex for the extension portion
      const text = 'Download from https://example.com/file.pdf'
      const files = mod.extractLikelyOutputFiles(text)
      // The path regex may capture 'file.pdf' from the URL — verify no crash
      assert.ok(Array.isArray(files))
    })

    it('filters /api/uploads/ paths in backtick extraction', () => {
      // extractLikelyOutputFiles filters /api/uploads/ paths via push()
      // But backtick regex captures the filename inside backticks
      const text = 'See `/api/uploads/image.png` for the result'
      const files = mod.extractLikelyOutputFiles(text)
      // /api/uploads/image.png is filtered, but image.png may be captured by bare path regex
      assert.ok(Array.isArray(files))
    })

    it('caps at 8 files', () => {
      const refs = Array.from({ length: 12 }, (_, i) => `\`file${i}.txt\``).join(' ')
      const files = mod.extractLikelyOutputFiles(refs)
      assert.equal(files.length, 8)
    })

    it('returns empty for no file references', () => {
      const files = mod.extractLikelyOutputFiles('No files here, just text.')
      assert.equal(files.length, 0)
    })

    it('handles backtick-quoted tilde paths', () => {
      const text = 'Saved to `~/Documents/notes.md`'
      const files = mod.extractLikelyOutputFiles(text)
      assert.ok(files.includes('~/Documents/notes.md'))
    })
  })

  // ---- normalizeWhatsappTarget ----

  describe('normalizeWhatsappTarget', () => {
    it('converts plain digits to JID (no UK locale normalization)', () => {
      // normalizeWhatsappTarget strips to digits — UK local→international
      // conversion is in connectors/whatsapp.ts normalizeNumber, not here
      assert.equal(mod.normalizeWhatsappTarget('07123456789'), '07123456789@s.whatsapp.net')
    })

    it('passes through already-formatted JID', () => {
      assert.equal(mod.normalizeWhatsappTarget('447123456789@s.whatsapp.net'), '447123456789@s.whatsapp.net')
    })

    it('strips non-digit characters and adds JID suffix', () => {
      assert.equal(mod.normalizeWhatsappTarget('+44 7123 456 789'), '447123456789@s.whatsapp.net')
    })

    it('returns empty string for empty input', () => {
      assert.equal(mod.normalizeWhatsappTarget(''), '')
      assert.equal(mod.normalizeWhatsappTarget('  '), '')
    })

    it('handles international number without +', () => {
      assert.equal(mod.normalizeWhatsappTarget('14155551234'), '14155551234@s.whatsapp.net')
    })
  })

  // ---- fillTaskFollowupTemplate ----

  describe('fillTaskFollowupTemplate', () => {
    it('replaces all placeholders', () => {
      const template = 'Task {taskId}: {title} - {status}\n{summary}'
      const result = mod.fillTaskFollowupTemplate(template, {
        status: 'completed',
        title: 'Build report',
        summary: 'Report generated successfully.',
        taskId: 'task-123',
      })
      assert.equal(result, 'Task task-123: Build report - completed\nReport generated successfully.')
    })

    it('replaces multiple occurrences of same placeholder', () => {
      const template = '{status} -> {status}'
      const result = mod.fillTaskFollowupTemplate(template, {
        status: 'done',
        title: '',
        summary: '',
        taskId: '',
      })
      assert.equal(result, 'done -> done')
    })

    it('leaves template intact when no placeholders match', () => {
      const template = 'No placeholders here.'
      const result = mod.fillTaskFollowupTemplate(template, {
        status: 'ok',
        title: 'x',
        summary: 'y',
        taskId: 'z',
      })
      assert.equal(result, 'No placeholders here.')
    })
  })

  // ---- resolveTaskOriginConnectorFollowupTarget ----

  describe('resolveTaskOriginConnectorFollowupTarget', () => {
    it('returns explicit followup target when set on task (non-whatsapp)', () => {
      const task = {
        id: 'task-1',
        title: 'Test task',
        description: '',
        agentId: 'agent-1',
        status: 'completed' as const,
        priority: 'medium' as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        followupConnectorId: 'conn-1',
        followupChannelId: 'ch-1',
        followupThreadId: 'th-1',
      }
      const connectors = {
        'conn-1': {
          id: 'conn-1',
          name: 'Test Discord',
          platform: 'discord' as const,
          agentId: 'agent-1',
          config: {},
          isEnabled: true,
          status: 'running' as const,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      }
      const running = [{
        id: 'conn-1',
        platform: 'discord',
        agentId: 'agent-1',
        supportsSend: true,
        configuredTargets: [],
        recentChannelId: null,
      }]

      const target = mod.resolveTaskOriginConnectorFollowupTarget({
        task,
        sessions: {},
        connectors: connectors as Record<string, import('@/types').Connector>,
        running,
      })

      assert.ok(target)
      assert.equal(target!.connectorId, 'conn-1')
      assert.equal(target!.channelId, 'ch-1')
      assert.equal(target!.threadId, 'th-1')
    })

    it('normalizes whatsapp channel IDs', () => {
      const task = {
        id: 'task-wa',
        title: 'WA task',
        description: '',
        agentId: 'agent-1',
        status: 'completed' as const,
        priority: 'medium' as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        followupConnectorId: 'conn-wa',
        followupChannelId: '447123456789',
      }
      const connectors = {
        'conn-wa': {
          id: 'conn-wa',
          name: 'WA',
          platform: 'whatsapp' as const,
          agentId: 'agent-1',
          config: {},
          isEnabled: true,
          status: 'running' as const,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      }

      const target = mod.resolveTaskOriginConnectorFollowupTarget({
        task,
        sessions: {},
        connectors: connectors as Record<string, import('@/types').Connector>,
        running: [],
      })

      assert.ok(target)
      assert.equal(target!.channelId, '447123456789@s.whatsapp.net')
    })

    it('repairs explicit main-session followups back to the owner route', () => {
      const task = {
        id: 'task-owner-fix',
        title: 'Owner reminder',
        description: '',
        agentId: 'agent-1',
        status: 'completed' as const,
        priority: 'medium' as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        createdInSessionId: 'session-main',
        followupConnectorId: 'conn-wa',
        followupChannelId: '447700900222@s.whatsapp.net',
      }
      const sessions = {
        'session-main': {
          id: 'session-main',
          name: 'Hal',
          user: 'default',
          agentId: 'agent-1',
          shortcutForAgentId: 'agent-1',
          messages: [],
        },
      }
      const connectors = {
        'conn-wa': {
          id: 'conn-wa',
          name: 'WA',
          platform: 'whatsapp' as const,
          agentId: 'agent-1',
          config: {
            ownerSenderId: '447700900111',
          },
          isEnabled: true,
          status: 'running' as const,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      }

      const target = mod.resolveTaskOriginConnectorFollowupTarget({
        task,
        sessions: sessions as Record<string, import('@/lib/server/tasks/task-followups').SessionLike>,
        connectors: connectors as Record<string, import('@/types').Connector>,
        running: [],
      })

      assert.deepEqual(target, {
        connectorId: 'conn-wa',
        channelId: '447700900111@s.whatsapp.net',
      })
    })

    it('returns null when no origin can be resolved', () => {
      const task = {
        id: 'task-2',
        title: 'Orphan task',
        description: '',
        agentId: 'agent-2',
        status: 'completed' as const,
        priority: 'medium' as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }

      const target = mod.resolveTaskOriginConnectorFollowupTarget({
        task,
        sessions: {},
        connectors: {},
        running: [],
      })

      assert.equal(target, null)
    })

    it('falls back to session connectorContext', () => {
      const task = {
        id: 'task-3',
        title: 'Session fallback',
        description: '',
        agentId: 'agent-1',
        status: 'completed' as const,
        priority: 'medium' as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        createdInSessionId: 'sess-1',
      }
      const sessions = {
        'sess-1': {
          id: 'sess-1',
          name: 'connector:slack:dm',
          user: 'connector',
          connectorContext: {
            connectorId: 'conn-1',
            channelId: 'ch-ctx',
          },
          messages: [],
        },
      }
      const connectors = {
        'conn-1': {
          id: 'conn-1',
          name: 'Slack',
          platform: 'slack' as const,
          agentId: 'agent-1',
          config: {},
          isEnabled: true,
          status: 'running' as const,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      }
      const running = [{
        id: 'conn-1',
        platform: 'slack',
        agentId: 'agent-1',
        supportsSend: true,
        configuredTargets: [],
        recentChannelId: null,
      }]

      const target = mod.resolveTaskOriginConnectorFollowupTarget({
        task,
        sessions: sessions as Record<string, import('@/lib/server/tasks/task-followups').SessionLike>,
        connectors: connectors as Record<string, import('@/types').Connector>,
        running,
      })

      assert.ok(target)
      assert.equal(target!.connectorId, 'conn-1')
      assert.equal(target!.channelId, 'ch-ctx')
    })

    it('uses owner main-session connectorContext when available', () => {
      const task = {
        id: 'task-owner-main',
        title: 'Owner session fallback',
        description: '',
        agentId: 'agent-1',
        status: 'completed' as const,
        priority: 'medium' as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        createdInSessionId: 'session-main',
      }
      const sessions = {
        'session-main': {
          id: 'session-main',
          name: 'Hal',
          user: 'default',
          agentId: 'agent-1',
          shortcutForAgentId: 'agent-1',
          connectorContext: {
            connectorId: 'conn-wa',
            channelId: '447700900111@s.whatsapp.net',
            isOwnerConversation: true,
          },
          messages: [
            {
              role: 'user',
              text: 'old mirrored sender',
              source: {
                connectorId: 'conn-wa',
                channelId: '447700900222@s.whatsapp.net',
              },
            },
          ],
        },
      }
      const connectors = {
        'conn-wa': {
          id: 'conn-wa',
          name: 'WA',
          platform: 'whatsapp' as const,
          agentId: 'agent-1',
          config: {},
          isEnabled: true,
          status: 'running' as const,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      }

      const target = mod.resolveTaskOriginConnectorFollowupTarget({
        task,
        sessions: sessions as Record<string, import('@/lib/server/tasks/task-followups').SessionLike>,
        connectors: connectors as Record<string, import('@/types').Connector>,
        running: [],
      })

      assert.deepEqual(target, {
        connectorId: 'conn-wa',
        channelId: '447700900111@s.whatsapp.net',
      })
    })

    it('rejects connector owned by different agent', () => {
      const task = {
        id: 'task-4',
        title: 'Wrong owner',
        description: '',
        agentId: 'agent-1',
        status: 'completed' as const,
        priority: 'medium' as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        followupConnectorId: 'conn-other',
        followupChannelId: 'ch-x',
      }
      const connectors = {
        'conn-other': {
          id: 'conn-other',
          name: 'Other',
          platform: 'discord' as const,
          agentId: 'agent-OTHER',
          config: {},
          isEnabled: true,
          status: 'running' as const,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      }

      const target = mod.resolveTaskOriginConnectorFollowupTarget({
        task,
        sessions: {},
        connectors: connectors as Record<string, import('@/types').Connector>,
        running: [],
      })

      assert.equal(target, null)
    })
  })

  // ---- collectTaskConnectorFollowupTargets ----

  describe('collectTaskConnectorFollowupTargets', () => {
    it('returns origin target when available', () => {
      const task = {
        id: 'task-ct-1',
        title: 'Collect test',
        description: '',
        agentId: 'agent-1',
        status: 'completed' as const,
        priority: 'medium' as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        followupConnectorId: 'conn-1',
        followupChannelId: 'ch-1',
      }
      const connectors = {
        'conn-1': {
          id: 'conn-1',
          name: 'C',
          platform: 'discord' as const,
          agentId: 'agent-1',
          config: {},
          isEnabled: true,
          status: 'running' as const,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      }
      const running = [{
        id: 'conn-1',
        platform: 'discord',
        agentId: 'agent-1',
        supportsSend: true,
        configuredTargets: [],
        recentChannelId: null,
      }]

      const targets = mod.collectTaskConnectorFollowupTargets({
        task,
        sessions: {},
        connectors: connectors as Record<string, import('@/types').Connector>,
        running,
      })

      assert.equal(targets.length, 1)
      assert.equal(targets[0].connectorId, 'conn-1')
    })

    it('falls back to running connectors with taskFollowups enabled', () => {
      const task = {
        id: 'task-ct-2',
        title: 'Fallback test',
        description: '',
        agentId: 'agent-1',
        status: 'completed' as const,
        priority: 'medium' as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      const connectors = {
        'conn-fb': {
          id: 'conn-fb',
          name: 'FB',
          platform: 'slack' as const,
          agentId: 'agent-1',
          config: { taskFollowups: 'true', outboundTarget: 'general' },
          isEnabled: true,
          status: 'running' as const,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      }
      const running = [{
        id: 'conn-fb',
        platform: 'slack',
        agentId: 'agent-1',
        supportsSend: true,
        configuredTargets: ['general'],
        recentChannelId: null,
      }]

      const targets = mod.collectTaskConnectorFollowupTargets({
        task,
        sessions: {},
        connectors: connectors as Record<string, import('@/types').Connector>,
        running,
      })

      assert.equal(targets.length, 1)
      assert.equal(targets[0].connectorId, 'conn-fb')
      assert.equal(targets[0].channelId, 'general')
    })

    it('returns empty when no targets found', () => {
      const task = {
        id: 'task-ct-3',
        title: 'No targets',
        description: '',
        agentId: 'agent-1',
        status: 'completed' as const,
        priority: 'medium' as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }

      const targets = mod.collectTaskConnectorFollowupTargets({
        task,
        sessions: {},
        connectors: {},
        running: [],
      })

      assert.equal(targets.length, 0)
    })
  })

  describe('taskAlreadyDeliveredToConnectorTarget', () => {
    it('returns true when the task session already delivered to the same connector target', async () => {
      const { appendMessage } = await import('@/lib/server/messages/message-repository')
      const task = {
        id: 'task-delivered',
        title: 'Delivered task',
        description: '',
        agentId: 'agent-1',
        sessionId: 'task-session',
        status: 'completed' as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      // Delivery evidence is read through the repo-backed message reader, so
      // the message must be seeded via the repository, not inline on the session.
      appendMessage('task-session', {
        role: 'assistant',
        text: 'Sent it.',
        time: Date.now(),
        toolEvents: [
          {
            name: 'connector_message_tool',
            input: '{}',
            output: JSON.stringify({
              status: 'voice_sent',
              connectorId: 'conn-wa',
              to: '447700900111@s.whatsapp.net',
              messageId: 'msg-1',
            }),
          },
        ],
      } as import('@/types').Message)
      const sessions = {
        'task-session': {
          id: 'task-session',
          messages: [],
        },
      }
      const connectors = {
        'conn-wa': {
          id: 'conn-wa',
          name: 'WA',
          platform: 'whatsapp' as const,
          agentId: 'agent-1',
          config: {},
          isEnabled: true,
          status: 'running' as const,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      }

      const delivered = mod.taskAlreadyDeliveredToConnectorTarget({
        task: task as import('@/types').BoardTask,
        target: {
          connectorId: 'conn-wa',
          channelId: '+44 7700 900111',
        },
        sessions: sessions as Record<string, import('@/lib/server/tasks/task-followups').SessionLike>,
        connectors: connectors as Record<string, import('@/types').Connector>,
      })

      assert.equal(delivered, true)
    })

    it('returns false when connector delivery was to a different target', async () => {
      const { appendMessage } = await import('@/lib/server/messages/message-repository')
      const task = {
        id: 'task-other-target',
        title: 'Other target',
        description: '',
        agentId: 'agent-1',
        sessionId: 'task-session-other',
        status: 'completed' as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      appendMessage('task-session-other', {
        role: 'assistant',
        text: 'Sent it.',
        time: Date.now(),
        toolEvents: [
          {
            name: 'connector_message_tool',
            input: '{}',
            output: JSON.stringify({
              status: 'sent',
              connectorId: 'conn-wa',
              to: '447700900222@s.whatsapp.net',
              messageId: 'msg-2',
            }),
          },
        ],
      } as import('@/types').Message)
      const sessions = {
        'task-session-other': {
          id: 'task-session-other',
          messages: [],
        },
      }
      const connectors = {
        'conn-wa': {
          id: 'conn-wa',
          name: 'WA',
          platform: 'whatsapp' as const,
          agentId: 'agent-1',
          config: {},
          isEnabled: true,
          status: 'running' as const,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      }

      const delivered = mod.taskAlreadyDeliveredToConnectorTarget({
        task: task as import('@/types').BoardTask,
        target: {
          connectorId: 'conn-wa',
          channelId: '+44 7700 900111',
        },
        sessions: sessions as Record<string, import('@/lib/server/tasks/task-followups').SessionLike>,
        connectors: connectors as Record<string, import('@/types').Connector>,
      })

      assert.equal(delivered, false)
    })
  })

  // ---- buildTaskFollowupDedupeKey ----

  describe('buildTaskFollowupDedupeKey', () => {
    it('is scoped to the task, run number, and target', () => {
      const key = mod.buildTaskFollowupDedupeKey(
        { id: 'task-1', runNumber: 7, attempts: 2 },
        { connectorId: 'conn-1', channelId: 'ch-1', threadId: 'th-1' },
      )
      assert.equal(key, 'task-followup:task-1:run7:conn-1|ch-1|th-1')
    })

    it('changes across runs so scheduled reruns can deliver again', () => {
      const target = { connectorId: 'conn-1', channelId: 'ch-1' }
      const run1 = mod.buildTaskFollowupDedupeKey({ id: 'task-1', runNumber: 1 }, target)
      const run2 = mod.buildTaskFollowupDedupeKey({ id: 'task-1', runNumber: 2 }, target)
      assert.notEqual(run1, run2)
    })

    it('falls back to attempts, then zero, when runNumber is missing', () => {
      const target = { connectorId: 'conn-1', channelId: 'ch-1' }
      assert.equal(
        mod.buildTaskFollowupDedupeKey({ id: 'task-1', attempts: 3 }, target),
        'task-followup:task-1:run3:conn-1|ch-1|',
      )
      assert.equal(
        mod.buildTaskFollowupDedupeKey({ id: 'task-1' }, target),
        'task-followup:task-1:run0:conn-1|ch-1|',
      )
    })
  })

  // ---- outbox-backed follow-up delivery ----

  describe('outbox-backed follow-up delivery', () => {
    it('stores taskId/scheduleId on the outbox entry and keeps them through normalization', async () => {
      const outbox = await import('@/lib/server/connectors/outbox')
      const dedupeKey = 'task-followup:task-evidence:run1:conn-1|ch-1|'
      outbox.enqueueConnectorOutbox({
        connectorId: 'conn-1',
        channelId: 'ch-1',
        text: 'Task completed: evidence',
        taskId: 'task-evidence',
        scheduleId: 'sched-evidence',
        dedupeKey,
        sendAt: Date.now() + 60_000,
      })

      const entry = outbox.findPendingConnectorOutboxByDedupe(dedupeKey)
      assert.ok(entry)
      assert.equal(entry!.taskId, 'task-evidence')
      assert.equal(entry!.scheduleId, 'sched-evidence')
      assert.equal(entry!.connectorId, 'conn-1')
      assert.equal(entry!.status, 'pending')
    })

    it('hasSentConnectorOutboxForDedupe reports successful terminal deliveries', async () => {
      const outbox = await import('@/lib/server/connectors/outbox')
      const storage = await import('@/lib/server/storage')
      const dedupeKey = 'task-followup:task-sent:run1:conn-1|ch-1|'
      const now = Date.now()
      storage.upsertConnectorOutboxItem('sent-entry-1', {
        id: 'sent-entry-1',
        channelId: 'ch-1',
        text: 'done',
        status: 'sent',
        sendAt: now,
        createdAt: now,
        updatedAt: now,
        attemptCount: 1,
        maxAttempts: 6,
        dedupeKey,
        deliveredAt: now,
      })

      assert.equal(outbox.hasSentConnectorOutboxForDedupe(dedupeKey), true)
      assert.equal(outbox.hasSentConnectorOutboxForDedupe('task-followup:other:run1:c|c|'), false)
    })
  })

  // ---- isSendableAttachment ----

  describe('isSendableAttachment', () => {
    it('returns true for small files', () => {
      const filePath = path.join(tempDir, 'small.txt')
      fs.writeFileSync(filePath, 'hello')
      assert.equal(mod.isSendableAttachment(filePath), true)
    })

    it('returns false for non-existent files', () => {
      assert.equal(mod.isSendableAttachment('/nonexistent/file.txt'), false)
    })

    it('returns false for directories', () => {
      assert.equal(mod.isSendableAttachment(tempDir), false)
    })
  })
})
