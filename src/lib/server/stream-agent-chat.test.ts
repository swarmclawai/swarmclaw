import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { buildToolDisciplineLines, getExplicitRequiredToolNames, looksLikeOpenEndedDeliverableTask } from './stream-agent-chat'

const streamAgentChatSource = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'stream-agent-chat.ts'), 'utf-8')

describe('buildToolDisciplineLines', () => {
  it('tells the agent to use direct platform tools when manage_platform is absent', () => {
    const lines = buildToolDisciplineLines(['files', 'manage_schedules'])

    assert.equal(lines[0], 'Enabled tools in this session: `files`, `manage_schedules`.')
    assert.ok(lines.some((line) => line.includes('Do not substitute `manage_platform`')))
  })

  it('omits the manage_platform warning when the umbrella tool is enabled', () => {
    const lines = buildToolDisciplineLines(['manage_platform', 'manage_schedules'])

    assert.ok(lines.every((line) => !line.includes('Do not substitute `manage_platform`')))
  })

  it('includes concrete files-tool examples for revision work', () => {
    const lines = buildToolDisciplineLines(['files'])

    assert.ok(lines.some((line) => line.includes('{"action":"read","filePath":"path/to/file.md"}')))
  })

  it('warns browser tasks to use literal urls and the supported form schema', () => {
    const lines = buildToolDisciplineLines(['web_search', 'web_fetch', 'browser', 'manage_connectors', 'http_request', 'email', 'ask_human'])

    assert.ok(lines.some((line) => line.includes('Do not invent placeholder URLs')))
    assert.ok(lines.some((line) => line.includes('A shorthand `form` object keyed by input id/name also works')))
    assert.ok(lines.some((line) => line.includes('For current events, breaking news, or "latest" requests, start with `web_search`')))
    assert.ok(lines.some((line) => line.includes('Use `browser` when the user asks for screenshots')))
    assert.ok(lines.some((line) => line.includes('do not capture screenshots') && line.includes('`browser`')))
    assert.ok(lines.some((line) => line.includes('connector_message_tool') && line.includes('list_running')))
    assert.ok(lines.some((line) => line.includes('connector/channel setup is missing')))
    assert.ok(lines.some((line) => line.includes('capture the artifact first with `browser`') && line.includes('`connector_message_tool`')))
    assert.ok(lines.some((line) => line.includes('Keep JSON request bodies as raw JSON strings')))
    assert.ok(lines.some((line) => line.includes('{"action":"send","to":"user@example.com","subject":"...","body":"..."}')))
    assert.ok(lines.some((line) => line.includes('do not guess or keep re-submitting blank forms')))
  })

  it('requires research, browser, and connector tools for hybrid news delivery requests', () => {
    const required = getExplicitRequiredToolNames(
      'Can you tell me more if there is any news related to the US-Iran war, and can you send me some screenshots and give me a summary and maybe send me a voice note about it?',
      ['web_search', 'web_fetch', 'browser', 'manage_connectors'],
    )

    assert.deepEqual(required, ['web_search', 'browser', 'connector_message_tool'])
  })

  it('requires connector delivery for explicit channel requests', () => {
    const required = getExplicitRequiredToolNames(
      'Research the latest launch news, take a screenshot, and send it to me over Slack.',
      ['web_search', 'browser', 'manage_connectors'],
    )

    assert.deepEqual(required, ['web_search', 'browser', 'connector_message_tool'])
  })

  it('tells the agent that named enabled tools are completion requirements', () => {
    assert.ok(streamAgentChatSource.includes('If a task explicitly names an enabled tool, use that tool before declaring success.'))
    assert.ok(streamAgentChatSource.includes('collect required human input through the tool'))
    assert.ok(streamAgentChatSource.includes('You have not yet completed the required explicit tool step(s):'))
    assert.ok(streamAgentChatSource.includes('do not replace screenshot requests with text-only summaries'))
    assert.ok(streamAgentChatSource.includes('[Loop Budget Reached]'))
  })
})

describe('looksLikeOpenEndedDeliverableTask', () => {
  it('detects open-ended deliverable prompts', () => {
    assert.equal(
      looksLikeOpenEndedDeliverableTask('Revise the landing copy and update the proposal draft with a stronger second pass.'),
      true,
    )
  })

  it('does not misclassify explicit coding tasks', () => {
    assert.equal(
      looksLikeOpenEndedDeliverableTask('Fix the React bug in src/components/chat/chat-area.tsx and run npm run build.'),
      false,
    )
  })
})
