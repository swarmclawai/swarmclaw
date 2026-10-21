import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'

import { AIMessage } from '@langchain/core/messages'
import { PROVIDERS } from './index'
import { streamOpenAiChat } from './openai'
import {
  attachReasoningContentToCompletionsMessages,
  getReasoningContentFromLangChainMessage,
} from './deepseek-reasoning-chat-openai'

function sseChunk(data: unknown) {
  return `data: ${JSON.stringify(data)}\n\n`
}

function parseSseEvents(frames: string[]) {
  return frames
    .flatMap((frame) => frame.trim().split('\n\n'))
    .filter(Boolean)
    .map((frame) => JSON.parse(frame.replace(/^data: /, '')) as { t: string; text?: string })
}

function mockedSseResponse(text = 'ok') {
  const encoded = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoded.encode(sseChunk({ choices: [{ delta: { content: text } }] })))
      controller.enqueue(encoded.encode('data: [DONE]\n\n'))
      controller.close()
    },
  }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

test('MiniMax Flash uses the global OpenAI route and default max reasoning effort', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body || '{}')) as Record<string, unknown> })
    return mockedSseResponse()
  }) as typeof fetch

  try {
    const result = await PROVIDERS.minimax.handler.streamChat({
      session: { id: 'minimax-flash-default', provider: 'minimax', model: 'MiniMax-M3.1-Flash' },
      message: 'hello',
      write: () => {},
      active: new Map(),
      loadHistory: () => [],
    })
    assert.equal(result, 'ok')
    assert.equal(calls[0]?.url, 'https://api.minimax.io/v1/chat/completions')
    assert.equal(calls[0]?.body.model, 'MiniMax-M3.1-Flash')
    assert.equal(calls[0]?.body.reasoning_effort, 'max')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('MiniMax M3 honors a saved regional endpoint while explicit legacy models remain routable', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body || '{}')) as Record<string, unknown> })
    return mockedSseResponse()
  }) as typeof fetch

  try {
    await PROVIDERS.minimax.handler.streamChat({
      session: {
        id: 'minimax-m3-regional',
        provider: 'minimax',
        model: 'MiniMax-M3',
        apiEndpoint: 'https://api.minimaxi.com/v1',
        thinkingLevel: 'high',
      },
      message: 'hello',
      write: () => {},
      active: new Map(),
      loadHistory: () => [],
    })
    await PROVIDERS.minimax.handler.streamChat({
      session: {
        id: 'minimax-legacy-custom',
        provider: 'minimax',
        model: 'MiniMax-M2.7',
        apiEndpoint: 'https://custom.example/minimax/v1',
      },
      message: 'hello',
      write: () => {},
      active: new Map(),
      loadHistory: () => [],
    })
    assert.equal(calls[0]?.url, 'https://api.minimaxi.com/v1/chat/completions')
    assert.equal(calls[0]?.body.model, 'MiniMax-M3')
    assert.equal(Object.prototype.hasOwnProperty.call(calls[0]?.body || {}, 'reasoning_effort'), false)
    assert.equal(calls[1]?.url, 'https://custom.example/minimax/v1/chat/completions')
    assert.equal(calls[1]?.body.model, 'MiniMax-M2.7')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('MiniMax Flash Anthropic route sends effort and preserves image content blocks', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body || '{}')) as Record<string, unknown> })
    const encoded = new TextEncoder()
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoded.encode(`data: ${JSON.stringify({ type: 'content_block_delta', delta: { text: 'ok' } })}\n\n`))
        controller.close()
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch

  try {
    await PROVIDERS.minimax.handler.streamChat({
      session: {
        id: 'minimax-flash-anthropic',
        provider: 'minimax',
        model: 'MiniMax-M3.1-Flash',
        apiEndpoint: 'https://api.minimaxi.com/anthropic',
        thinkingLevel: 'high',
      },
      message: 'describe this',
      imagePath: path.resolve(process.cwd(), 'resources/icon.png'),
      apiKey: 'test-key',
      write: () => {},
      active: new Map(),
      loadHistory: () => [],
    })
    const body = calls[0]?.body
    const content = (body?.messages as Array<{ content?: unknown }> | undefined)?.[0]?.content
    assert.equal(calls[0]?.url, 'https://api.minimaxi.com/anthropic/v1/messages')
    assert.deepEqual(body?.output_config, { effort: 'high' })
    assert.equal(Array.isArray(content), true)
    assert.equal((content as Array<{ type: string }>)[0]?.type, 'image')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('OpenAI-compatible reasoning deltas stream as thinking instead of visible text', async () => {
  const originalFetch = globalThis.fetch
  const encoded = new TextEncoder()
  const frames = [
    sseChunk({ choices: [{ delta: { reasoning_content: 'internal reasoning ' } }] }),
    sseChunk({ choices: [{ delta: { content: 'visible answer' } }] }),
    'data: [DONE]\n\n',
  ]
  const writes: string[] = []

  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoded.encode(frame))
      controller.close()
    },
  }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })

  try {
    const result = await streamOpenAiChat({
      session: { id: 'session-1', provider: 'openai', model: 'test-model' },
      message: 'hello',
      write: (data) => writes.push(data),
      active: new Map(),
      loadHistory: () => [],
    } as Parameters<typeof streamOpenAiChat>[0])

    assert.equal(result, 'visible answer')
    const events = parseSseEvents(writes)
    assert.deepEqual(events, [
      { t: 'thinking', text: 'internal reasoning ' },
      { t: 'md', text: JSON.stringify({ reasoningContentDelta: 'internal reasoning ' }) },
      { t: 'd', text: 'visible answer' },
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('OpenAI-compatible DeepSeek history replays stored assistant reasoning_content', async () => {
  const originalFetch = globalThis.fetch
  const encoded = new TextEncoder()
  const frames = [
    sseChunk({ choices: [{ delta: { content: 'next answer' } }] }),
    'data: [DONE]\n\n',
  ]
  const writes: string[] = []
  const capture: { requestBody?: { messages?: Array<Record<string, unknown>> } } = {}

  globalThis.fetch = async (_url, init) => {
    capture.requestBody = JSON.parse(String(init?.body || '{}')) as { messages?: Array<Record<string, unknown>> }
    return new Response(new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoded.encode(frame))
        controller.close()
      },
    }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }

  try {
    await streamOpenAiChat({
      session: {
        id: 'session-1',
        provider: 'deepseek',
        model: 'deepseek-reasoner',
        apiEndpoint: 'https://api.deepseek.com/v1',
      },
      message: 'next',
      write: (data) => writes.push(data),
      active: new Map(),
      loadHistory: () => [{
        role: 'assistant',
        text: 'visible answer',
        reasoningContent: 'hidden chain',
      }],
    } as Parameters<typeof streamOpenAiChat>[0])

    const messages = capture.requestBody?.messages
    assert.deepEqual(messages, [
      { role: 'assistant', content: 'visible answer', reasoning_content: 'hidden chain' },
      { role: 'user', content: 'next' },
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('DeepSeek reasoning helper preserves native reasoning for LangChain replay', () => {
  const assistant = new AIMessage({
    content: 'visible answer',
    additional_kwargs: { reasoning_content: 'hidden chain' },
  })

  assert.equal(getReasoningContentFromLangChainMessage(assistant), 'hidden chain')
  assert.deepEqual(attachReasoningContentToCompletionsMessages([
    { role: 'assistant', content: 'visible answer' },
  ], [assistant]), [
    { role: 'assistant', content: 'visible answer', reasoning_content: 'hidden chain' },
  ])
})
