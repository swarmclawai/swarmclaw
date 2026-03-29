import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

let mod: typeof import('@/lib/server/chat-execution/stream-continuation')

before(async () => {
  process.env.SWARMCLAW_BUILD_MODE = '1'
  mod = await import('@/lib/server/chat-execution/stream-continuation')
})

after(() => {
  delete process.env.SWARMCLAW_BUILD_MODE
})

describe('stream-continuation', () => {
  // ---- isBroadGoal ----
  describe('isBroadGoal', () => {
    it('returns false for short text (<50 chars)', () => {
      assert.equal(mod.isBroadGoal('Fix the bug'), false)
    })

    it('returns false when text contains code blocks', () => {
      const text = 'Please implement the following feature that does many things with lots of detail ```code here```'
      assert.equal(mod.isBroadGoal(text), false)
    })

    it('returns false when text contains file paths', () => {
      const text = 'Please update the component at /src/components/chat/message-bubble.tsx to handle the new case properly'
      assert.equal(mod.isBroadGoal(text), false)
    })

    it('returns false for numbered lists', () => {
      const text = 'Here is a long enough request that has plenty of content to pass the length check\n1. First do this thing'
      assert.equal(mod.isBroadGoal(text), false)
    })

    it('returns false for short questions', () => {
      // Under 80 chars + ends with ? → false
      const text = 'What is the capital of France and why is it so important?'
      assert.equal(mod.isBroadGoal(text), false)
    })

    it('returns true for long natural language text', () => {
      const text = 'Build me a comprehensive dashboard that tracks all the different metrics we care about and shows them in a beautiful layout with charts and graphs'
      assert.equal(mod.isBroadGoal(text), true)
    })
  })

  // ---- looksLikeOpenEndedDeliverableTask ----
  describe('looksLikeOpenEndedDeliverableTask', () => {
    it('matches deliverable patterns', () => {
      assert.equal(mod.looksLikeOpenEndedDeliverableTask('write a detailed report on market trends'), true)
      assert.equal(mod.looksLikeOpenEndedDeliverableTask('create a proposal for the new feature'), true)
      assert.equal(mod.looksLikeOpenEndedDeliverableTask('draft a landing page copy'), true)
    })

    it('returns false for code-related text', () => {
      assert.equal(mod.looksLikeOpenEndedDeliverableTask('fix the bug in package.json and run npm run build'), false)
      assert.equal(mod.looksLikeOpenEndedDeliverableTask('write a tsx component with vitest'), false)
    })

    it('returns false for empty string', () => {
      assert.equal(mod.looksLikeOpenEndedDeliverableTask(''), false)
    })

    it('matches file-save patterns for broad goals', () => {
      assert.equal(
        mod.looksLikeOpenEndedDeliverableTask(
          'Research the competitor landscape and create a comprehensive markdown report covering all major players in the market, save it to ./reports/competitors.md',
        ),
        true,
      )
    })

    it('matches dashboard/HTML patterns for broad goals', () => {
      assert.equal(
        mod.looksLikeOpenEndedDeliverableTask(
          'Build me a beautiful dashboard that shows all the analytics data, create the html page with charts and deploy it to the dev server',
        ),
        true,
      )
    })
  })

  // ---- countExternalExecutionResearchSteps ----
  describe('countExternalExecutionResearchSteps', () => {
    it('counts http/web/browser tools', () => {
      const events = [
        { name: 'web_search', input: 'query', output: 'results' },
        { name: 'browser', input: 'url', output: 'page' },
        { name: 'shell', input: 'ls', output: 'files' },
      ]
      assert.equal(mod.countExternalExecutionResearchSteps(events), 2)
    })

    it('does not count non-research tools', () => {
      const events = [
        { name: 'shell', input: 'ls', output: 'files' },
        { name: 'files', input: 'read', output: 'content' },
      ]
      assert.equal(mod.countExternalExecutionResearchSteps(events), 0)
    })
  })

  // ---- countDistinctExternalResearchHosts ----
  describe('countDistinctExternalResearchHosts', () => {
    it('counts unique hosts from URLs in tool events', () => {
      const events = [
        { name: 'web', input: 'https://example.com/page1', output: 'https://example.com/page2' },
        { name: 'web', input: 'https://other.org/api', output: '' },
      ]
      assert.equal(mod.countDistinctExternalResearchHosts(events), 2)
    })

    it('deduplicates same host', () => {
      const events = [
        { name: 'web', input: 'https://example.com/a', output: 'https://example.com/b' },
      ]
      assert.equal(mod.countDistinctExternalResearchHosts(events), 1)
    })
  })

  // ---- shouldForceDeliverableFollowthrough ----
  describe('shouldForceDeliverableFollowthrough', () => {
    it('returns true when file-write tool used + deliverable task + incomplete response', () => {
      assert.equal(mod.shouldForceDeliverableFollowthrough({
        userMessage: 'write a detailed report and save it to ./report.md',
        finalResponse: 'Let me create...',
        hasToolCalls: true,
        toolEvents: [
          { name: 'web_search', input: 'research', output: 'data' },
          { name: 'write_file', input: './report.md', output: 'ok' },
        ],
      }), true)
    })

    it('returns false for non-deliverable tasks', () => {
      assert.equal(mod.shouldForceDeliverableFollowthrough({
        userMessage: 'what time is it?',
        finalResponse: 'It is 3pm.',
        hasToolCalls: false,
        toolEvents: [],
      }), false)
    })
  })

  // ---- hasIncompleteDelegationWait ----
  describe('hasIncompleteDelegationWait', () => {
    it('detects incomplete batch delegation', () => {
      const events = [{
        name: 'spawn_subagent',
        input: JSON.stringify({ action: 'batch', background: false }),
        output: JSON.stringify({
          action: 'batch',
          status: 'running',
          totalSpawned: 3,
          totalCompleted: 1,
          totalFailed: 0,
          totalCancelled: 0,
        }),
      }]
      assert.equal(mod.hasIncompleteDelegationWait(events), true)
    })

    it('returns false when all delegations completed', () => {
      const events = [{
        name: 'spawn_subagent',
        input: JSON.stringify({ action: 'batch' }),
        output: JSON.stringify({
          action: 'batch',
          status: 'completed',
          totalSpawned: 3,
          totalCompleted: 3,
          totalFailed: 0,
          totalCancelled: 0,
        }),
      }]
      assert.equal(mod.hasIncompleteDelegationWait(events), false)
    })

    it('returns false for background delegations', () => {
      const events = [{
        name: 'spawn_subagent',
        input: JSON.stringify({ action: 'batch', background: true }),
        output: JSON.stringify({
          action: 'batch',
          status: 'running',
          totalSpawned: 3,
          totalCompleted: 1,
          totalFailed: 0,
          totalCancelled: 0,
        }),
      }]
      assert.equal(mod.hasIncompleteDelegationWait(events), false)
    })

    it('returns false for undefined/empty events', () => {
      assert.equal(mod.hasIncompleteDelegationWait(undefined), false)
      assert.equal(mod.hasIncompleteDelegationWait([]), false)
    })
  })

  // ---- renderToolEvidence ----
  describe('renderToolEvidence', () => {
    it('renders last 10 events with name/input/output', () => {
      const events = [{ name: 'web', input: 'query', output: 'result data' }]
      const rendered = mod.renderToolEvidence(events)
      assert.ok(rendered.includes('Tool 1: web'))
      assert.ok(rendered.includes('Input: query'))
      assert.ok(rendered.includes('Output: result data'))
    })
  })

  // ---- buildContinuationPrompt ----
  describe('buildContinuationPrompt', () => {
    it('returns null for false/transient types', () => {
      const base = { message: 'test', fullText: '', toolEvents: [], requiredToolReminderNames: [] }
      assert.equal(mod.buildContinuationPrompt({ ...base, type: false }), null)
      assert.equal(mod.buildContinuationPrompt({ ...base, type: 'transient' }), null)
    })

    it('returns a string for recursion type', () => {
      const prompt = mod.buildContinuationPrompt({
        type: 'recursion',
        message: 'test',
        fullText: '',
        toolEvents: [],
        requiredToolReminderNames: [],
      })
      assert.equal(typeof prompt, 'string')
      assert.ok(prompt!.length > 0)
    })

    it('returns a string for memory_write_followthrough type', () => {
      const prompt = mod.buildContinuationPrompt({
        type: 'memory_write_followthrough',
        message: 'test',
        fullText: '',
        toolEvents: [],
        requiredToolReminderNames: [],
      })
      assert.equal(typeof prompt, 'string')
      assert.ok(prompt!.includes('memory write'))
    })

    it('renders a coordinator delegation nudge with the recommended delegate', () => {
      const prompt = mod.buildContinuationPrompt({
        type: 'coordinator_delegation_nudge',
        message: 'test',
        fullText: '',
        toolEvents: [],
        requiredToolReminderNames: [],
        isCoordinatorAgent: true,
        recommendedDelegateName: 'Builder',
        delegationRationale: 'capability match: coding; worker role fits execution-heavy work',
      })

      assert.ok(prompt)
      assert.ok(prompt!.includes('Builder'))
      assert.ok(prompt!.includes('orchestrate'))
      assert.ok(prompt!.includes('Reason: capability match: coding; worker role fits execution-heavy work.'))
    })

    it('renders an advisory delegation nudge for non-coordinator agents', () => {
      const prompt = mod.buildContinuationPrompt({
        type: 'coordinator_delegation_nudge',
        message: 'test',
        fullText: '',
        toolEvents: [],
        requiredToolReminderNames: [],
        isCoordinatorAgent: false,
        recommendedDelegateName: 'Reviewer',
        delegationRationale: 'capability match: review; currently idle',
      })

      assert.ok(prompt)
      assert.ok(prompt!.includes('materially better fit'))
      assert.ok(prompt!.includes('Reviewer'))
      assert.ok(prompt!.includes('reconnaissance, validation, or synthesis'))
    })
  })
})
