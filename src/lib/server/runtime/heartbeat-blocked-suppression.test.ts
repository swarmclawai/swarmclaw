import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  stripBlockedItems,
  isHeartbeatContentEffectivelyEmpty,
  buildAgentHeartbeatPrompt,
} from '@/lib/server/runtime/heartbeat-service'

describe('heartbeat blocked-item suppression', () => {
  describe('stripBlockedItems', () => {
    it('removes checklist items marked (blocked, no update)', () => {
      const input = [
        '# Heartbeat Tasks',
        '## Active',
        '- [ ] Pull SWGOH roster data (blocked, no update)',
        '- [ ] Send daily summary',
        '## Completed',
        '- [x] Do laundry',
      ].join('\n')

      const result = stripBlockedItems(input)

      assert.ok(!result.includes('SWGOH'), 'blocked item should be stripped')
      assert.ok(result.includes('Send daily summary'), 'non-blocked item should remain')
      assert.ok(result.includes('Do laundry'), 'completed item should remain')
      assert.ok(result.includes('# Heartbeat Tasks'), 'headers should remain')
    })

    it('removes items with various blocked markers', () => {
      const input = [
        '- [ ] Task A (blocked: awaiting input)',
        '- [ ] Task B (Blocked, pending user decision)',
        '- [ ] Task C (BLOCKED)',
        '- [ ] Task D - normal task',
        '* [ ] Task E (blocked, no update)',
      ].join('\n')

      const result = stripBlockedItems(input)

      assert.ok(!result.includes('Task A'), 'blocked: variant stripped')
      assert.ok(!result.includes('Task B'), 'Blocked, variant stripped')
      assert.ok(!result.includes('Task C'), 'BLOCKED variant stripped')
      assert.ok(result.includes('Task D'), 'non-blocked task preserved')
      assert.ok(!result.includes('Task E'), 'asterisk list item stripped')
    })

    it('preserves non-list lines that mention "blocked"', () => {
      const input = [
        '## Notes',
        'Some items are blocked until user responds.',
        '- [ ] Actual blocked task (blocked, no update)',
      ].join('\n')

      const result = stripBlockedItems(input)

      assert.ok(result.includes('Some items are blocked'), 'prose mentioning blocked should stay')
      assert.ok(!result.includes('Actual blocked task'), 'blocked list item should be stripped')
    })

    it('returns empty string for empty input', () => {
      assert.equal(stripBlockedItems(''), '')
      assert.equal(stripBlockedItems(null as unknown as string), '')
    })

    it('returns content unchanged when no blocked items', () => {
      const input = '- [ ] Task A\n- [ ] Task B\n'
      assert.equal(stripBlockedItems(input), input)
    })
  })

  describe('blocked items + effectively empty', () => {
    it('treats content with only blocked items as effectively empty', () => {
      const input = [
        '# Heartbeat Tasks',
        '## Active',
        '- [ ] Pull SWGOH data (blocked, no update)',
        '## Completed',
      ].join('\n')

      const stripped = stripBlockedItems(input)
      // After stripping, only headers remain — effectively empty
      assert.equal(isHeartbeatContentEffectivelyEmpty(stripped), true)
    })

    it('treats content with blocked + active items as not empty', () => {
      const input = [
        '# Heartbeat Tasks',
        '## Active',
        '- [ ] Pull SWGOH data (blocked, no update)',
        '- [ ] Send daily summary',
      ].join('\n')

      const stripped = stripBlockedItems(input)
      assert.equal(isHeartbeatContentEffectivelyEmpty(stripped), false)
    })
  })

  describe('buildAgentHeartbeatPrompt integration', () => {
    it('does not include blocked items in the prompt sent to the LLM', () => {
      const session = {
        id: 'test-session',
        cwd: '/tmp',
        messages: [],
      }
      const agent = {
        id: 'test-agent',
        name: 'Test',
        description: 'Test agent',
      }

      const heartbeatFileContent = [
        '# Heartbeat Tasks',
        '## Active',
        '- [ ] Pull SWGOH roster data (blocked, no update)',
        '- [ ] Check weather forecast',
        '## Completed',
        '- [x] Laundry done',
      ].join('\n')

      const prompt = buildAgentHeartbeatPrompt(session, agent, 'default prompt', heartbeatFileContent)

      assert.ok(!prompt.includes('SWGOH'), 'blocked SWGOH task should not appear in prompt')
      assert.ok(prompt.includes('Check weather forecast'), 'non-blocked task should appear')
      assert.ok(prompt.includes('Laundry done'), 'completed task should appear')
    })

    it('produces no HEARTBEAT.md section when all active items are blocked', () => {
      const session = {
        id: 'test-session',
        cwd: '/tmp',
        messages: [],
      }
      const agent = {
        id: 'test-agent',
        name: 'Test',
        description: 'Test agent',
      }

      const heartbeatFileContent = [
        '# Heartbeat Tasks',
        '## Active',
        '- [ ] Task A (blocked, no update)',
        '- [ ] Task B (blocked: awaiting user)',
      ].join('\n')

      const prompt = buildAgentHeartbeatPrompt(session, agent, 'default prompt', heartbeatFileContent)

      assert.ok(!prompt.includes('HEARTBEAT.md contents:'), 'should not include HEARTBEAT.md section when all items are blocked')
    })
  })
})
