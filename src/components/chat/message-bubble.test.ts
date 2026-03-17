import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

describe('MessageBubble', () => {
  it('renders media-only assistant turns without an empty markdown body', async () => {
    const messageBubbleModule = await import('./message-bubble') as Record<string, unknown>
    const MessageBubble = (
      messageBubbleModule.MessageBubble
      || (messageBubbleModule.default as { MessageBubble?: unknown } | undefined)?.MessageBubble
      || (messageBubbleModule['module.exports'] as { MessageBubble?: unknown } | undefined)?.MessageBubble
    ) as typeof import('./message-bubble').MessageBubble | undefined
    assert.ok(MessageBubble)
    const html = renderToStaticMarkup(
      React.createElement(MessageBubble, {
        message: {
          role: 'assistant',
          text: '',
          time: Date.now(),
          kind: 'chat',
          toolEvents: [
            {
              name: 'browser',
              input: '{"action":"screenshot"}',
              output: '![Screenshot](/api/uploads/test-screenshot.png)',
            },
          ],
        },
        assistantName: 'Hal2k-3',
        agentName: 'Hal2k-3',
      }),
    )

    assert.match(html, /\/api\/uploads\/test-screenshot\.png/)
    assert.doesNotMatch(html, /msg-content text-\[15px]/)
    assert.doesNotMatch(html, /streaming-cursor/)
  })

  it('falls back to persisted streaming content when the live stream payload is temporarily empty', async () => {
    const messageBubbleModule = await import('./message-bubble') as Record<string, unknown>
    const MessageBubble = (
      messageBubbleModule.MessageBubble
      || (messageBubbleModule.default as { MessageBubble?: unknown } | undefined)?.MessageBubble
      || (messageBubbleModule['module.exports'] as { MessageBubble?: unknown } | undefined)?.MessageBubble
    ) as typeof import('./message-bubble').MessageBubble | undefined
    assert.ok(MessageBubble)

    const html = renderToStaticMarkup(
      React.createElement(MessageBubble, {
        message: {
          role: 'assistant',
          text: 'Recovered persisted partial text',
          time: Date.now(),
          kind: 'chat',
          streaming: true,
        },
        assistantName: 'Hal2k-3',
        agentName: 'Hal2k-3',
        liveStream: {
          active: true,
          phase: 'responding',
          toolName: '',
          text: '',
          thinking: '',
          toolEvents: [],
        },
      }),
    )

    assert.match(html, /Recovered persisted partial text/)
    assert.match(html, /streaming-cursor/)
  })

  it('renders upload-linked screenshots inline without duplicating them at the bottom', async () => {
    const messageBubbleModule = await import('./message-bubble') as Record<string, unknown>
    const MessageBubble = (
      messageBubbleModule.MessageBubble
      || (messageBubbleModule.default as { MessageBubble?: unknown } | undefined)?.MessageBubble
      || (messageBubbleModule['module.exports'] as { MessageBubble?: unknown } | undefined)?.MessageBubble
    ) as typeof import('./message-bubble').MessageBubble | undefined
    assert.ok(MessageBubble)
    const html = renderToStaticMarkup(
      React.createElement(MessageBubble, {
        message: {
          role: 'assistant',
          text: [
            "I've sent you two screenshots:",
            '',
            '1. **Sunflower** (Download: [screenshot-1.png](/api/uploads/1773570599000-screenshot-1.png))',
            '',
            '2. **Quantum** (Download: [screenshot-2.png](/api/uploads/1773570616255-screenshot-2.png))',
          ].join('\n'),
          time: Date.now(),
          kind: 'chat',
          toolEvents: [
            {
              name: 'browser',
              input: '{"action":"screenshot"}',
              output: '![Screenshot](/api/uploads/screenshot-1.png)',
            },
            {
              name: 'browser',
              input: '{"action":"screenshot"}',
              output: '![Screenshot](/api/uploads/screenshot-2.png)',
            },
            {
              name: 'send_file',
              input: '{"filePath":"/api/uploads/screenshot-1.png"}',
              output: '[Download screenshot-1.png](/api/uploads/1773570599000-screenshot-1.png)',
            },
            {
              name: 'send_file',
              input: '{"filePath":"/api/uploads/screenshot-2.png"}',
              output: '[Download screenshot-2.png](/api/uploads/1773570616255-screenshot-2.png)',
            },
          ],
        },
        assistantName: 'Hal2k-3',
        agentName: 'Hal2k-3',
      }),
    )

    assert.match(html, /screenshot-1\.png/)
    assert.match(html, /screenshot-2\.png/)
    assert.equal((html.match(/<img /g) || []).length, 2)
    assert.doesNotMatch(html, /flex flex-col gap-2 mt-3"><\/div>/)
  })

  it('interleaves live streaming screenshots between paragraphs instead of only appending them at the bottom', async () => {
    const messageBubbleModule = await import('./message-bubble') as Record<string, unknown>
    const MessageBubble = (
      messageBubbleModule.MessageBubble
      || (messageBubbleModule.default as { MessageBubble?: unknown } | undefined)?.MessageBubble
      || (messageBubbleModule['module.exports'] as { MessageBubble?: unknown } | undefined)?.MessageBubble
    ) as typeof import('./message-bubble').MessageBubble | undefined
    assert.ok(MessageBubble)

    const html = renderToStaticMarkup(
      React.createElement(MessageBubble, {
        message: {
          role: 'assistant',
          text: '',
          time: Date.now(),
          kind: 'chat',
        },
        assistantName: 'Hal2k',
        agentName: 'Hal2k',
        liveStream: {
          active: true,
          phase: 'responding',
          toolName: '',
          text: [
            'First paragraph before the first screenshot.',
            '',
            'Second paragraph before the second screenshot.',
          ].join('\n'),
          thinking: '',
          toolEvents: [
            {
              id: 'tool-1',
              name: 'browser',
              input: '{"action":"screenshot"}',
              output: '![Screenshot](/api/uploads/first-stream.png)',
              status: 'done',
            },
            {
              id: 'tool-2',
              name: 'browser',
              input: '{"action":"screenshot"}',
              output: '![Screenshot](/api/uploads/second-stream.png)',
              status: 'done',
            },
          ],
        },
      }),
    )

    const firstParagraphIndex = html.indexOf('First paragraph before the first screenshot.')
    const firstImageIndex = html.indexOf('/api/uploads/first-stream.png')
    const secondParagraphIndex = html.indexOf('Second paragraph before the second screenshot.')
    const secondImageIndex = html.indexOf('/api/uploads/second-stream.png')

    assert.ok(firstParagraphIndex >= 0)
    assert.ok(firstImageIndex > firstParagraphIndex)
    assert.ok(secondParagraphIndex > firstImageIndex)
    assert.ok(secondImageIndex > secondParagraphIndex)
    assert.equal((html.match(/<img /g) || []).length, 2)
  })

  it('interleaves live streaming screenshots for single-newline prose instead of waiting until the end', async () => {
    const messageBubbleModule = await import('./message-bubble') as Record<string, unknown>
    const MessageBubble = (
      messageBubbleModule.MessageBubble
      || (messageBubbleModule.default as { MessageBubble?: unknown } | undefined)?.MessageBubble
      || (messageBubbleModule['module.exports'] as { MessageBubble?: unknown } | undefined)?.MessageBubble
    ) as typeof import('./message-bubble').MessageBubble | undefined
    assert.ok(MessageBubble)

    const html = renderToStaticMarkup(
      React.createElement(MessageBubble, {
        message: {
          role: 'assistant',
          text: '',
          time: Date.now(),
          kind: 'chat',
        },
        assistantName: 'Hal2k',
        agentName: 'Hal2k',
        liveStream: {
          active: true,
          phase: 'responding',
          toolName: '',
          text: [
            'First live line before the first screenshot.',
            'Second live line before the second screenshot.',
          ].join('\n'),
          thinking: '',
          toolEvents: [
            {
              id: 'tool-1',
              name: 'browser',
              input: '{"action":"screenshot"}',
              output: '![Screenshot](/api/uploads/first-single-line.png)',
              status: 'done',
            },
            {
              id: 'tool-2',
              name: 'browser',
              input: '{"action":"screenshot"}',
              output: '![Screenshot](/api/uploads/second-single-line.png)',
              status: 'done',
            },
          ],
        },
      }),
    )

    const firstLineIndex = html.indexOf('First live line before the first screenshot.')
    const firstImageIndex = html.indexOf('/api/uploads/first-single-line.png')
    const secondLineIndex = html.indexOf('Second live line before the second screenshot.')
    const secondImageIndex = html.indexOf('/api/uploads/second-single-line.png')

    assert.ok(firstLineIndex >= 0)
    assert.ok(firstImageIndex > firstLineIndex)
    assert.ok(secondLineIndex > firstImageIndex)
    assert.ok(secondImageIndex > secondLineIndex)
    assert.equal((html.match(/<img /g) || []).length, 2)
  })

  it('renders connector-delivery transcript as the primary message content', async () => {
    const messageBubbleModule = await import('./message-bubble') as Record<string, unknown>
    const MessageBubble = (
      messageBubbleModule.MessageBubble
      || (messageBubbleModule.default as { MessageBubble?: unknown } | undefined)?.MessageBubble
      || (messageBubbleModule['module.exports'] as { MessageBubble?: unknown } | undefined)?.MessageBubble
    ) as typeof import('./message-bubble').MessageBubble | undefined
    assert.ok(MessageBubble)

    const html = renderToStaticMarkup(
      React.createElement(MessageBubble, {
        message: {
          role: 'assistant',
          text: 'Message delivered.',
          time: Date.now(),
          kind: 'connector-delivery',
          source: {
            platform: 'telegram',
            connectorId: 'connector-1',
            connectorName: 'Telegram',
            channelId: 'chat-1',
            senderId: 'user-1',
            senderName: 'Wayde',
            deliveryTranscript: 'I tested the platform and sent the update through Telegram.',
            deliveryMode: 'text',
          },
        },
        assistantName: 'Hal2k',
        agentName: 'Hal2k',
      }),
    )

    assert.match(html, /Delivered via connector/)
    assert.match(html, /I tested the platform and sent the update through Telegram\./)
    assert.doesNotMatch(html, />Message delivered\.<\/p>/)
  })
})
