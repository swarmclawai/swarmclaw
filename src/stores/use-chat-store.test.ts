import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import type { Agent, Session } from '@/types'
import { useAppStore } from './use-app-store'
import { useChatStore } from './use-chat-store'

const originalFetch = global.fetch
const originalChatState = useChatStore.getState()
const originalAppState = {
  agents: useAppStore.getState().agents,
  sessions: useAppStore.getState().sessions,
  currentAgentId: useAppStore.getState().currentAgentId,
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Agent One',
    description: '',
    systemPrompt: '',
    provider: 'openai',
    model: 'gpt-5',
    extensions: ['memory'],
    createdAt: 1,
    updatedAt: 1,
    threadSessionId: 'session-1',
    ...overrides,
  } as Agent
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    name: 'Session One',
    cwd: '/tmp',
    user: 'default',
    provider: 'openai',
    model: 'gpt-5',
    claudeSessionId: null,
    codexThreadId: null,
    opencodeSessionId: null,
    delegateResumeIds: { claudeCode: null, codex: null, opencode: null, gemini: null },
    messages: [],
    createdAt: 1,
    lastActiveAt: 1,
    extensions: ['memory'],
    ...overrides,
  } as Session
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function sseResponse(events: unknown[]): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n`))
      }
      controller.close()
    },
  }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

afterEach(() => {
  global.fetch = originalFetch
  useChatStore.setState(originalChatState)
  useAppStore.setState({
    agents: originalAppState.agents,
    sessions: originalAppState.sessions,
    currentAgentId: originalAppState.currentAgentId,
  })
})

describe('useChatStore control-token hygiene', () => {
  it('does not add a visible assistant bubble for a control-token-only direct reply', async () => {
    const session = makeSession()
    useAppStore.setState({
      agents: { 'agent-1': makeAgent() },
      sessions: { [session.id]: session },
      currentAgentId: 'agent-1',
    })
    useChatStore.setState({
      messages: [],
      pendingFiles: [],
      replyingTo: null,
      toolEvents: [],
      streamText: '',
      displayText: '',
      streaming: false,
      streamingSessionId: null,
      streamSource: null,
      assistantRenderId: null,
      streamPhase: 'thinking',
      streamToolName: '',
      thinkingText: '',
      thinkingStartTime: 0,
      queuedMessages: [],
      agentStatus: null,
      lastUsage: null,
      hasMoreMessages: false,
      loadingMore: false,
      totalMessages: 0,
    })

    global.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/chats/session-1/chat') {
        return sseResponse([
          { t: 'r', text: 'NO_MESSAGE' },
          { t: 'done' },
        ])
      }
      if (url === '/api/chats/session-1') {
        return new Response(JSON.stringify(session), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    await useChatStore.getState().sendMessage('Hello', { sessionId: 'session-1' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const messages = useChatStore.getState().messages
    assert.equal(messages.length, 1)
    assert.equal(messages[0]?.role, 'user')
    assert.equal(messages[0]?.text, 'Hello')
    assert.equal(useChatStore.getState().streamText, '')
    assert.equal(useChatStore.getState().displayText, '')
  })

  it('keeps a stable client render id on the completed assistant message', async () => {
    const session = makeSession()
    useAppStore.setState({
      agents: { 'agent-1': makeAgent() },
      sessions: { [session.id]: session },
      currentAgentId: 'agent-1',
    })
    useChatStore.setState({
      messages: [],
      pendingFiles: [],
      replyingTo: null,
      toolEvents: [],
      streamText: '',
      displayText: '',
      streaming: false,
      streamingSessionId: null,
      streamSource: null,
      assistantRenderId: null,
      streamPhase: 'thinking',
      streamToolName: '',
      thinkingText: '',
      thinkingStartTime: 0,
      queuedMessages: [],
      agentStatus: null,
      lastUsage: null,
      hasMoreMessages: false,
      loadingMore: false,
      totalMessages: 0,
    })

    global.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/chats/session-1/chat') {
        return sseResponse([
          { t: 'r', text: 'Stable final answer' },
          { t: 'done' },
        ])
      }
      if (url === '/api/chats/session-1') {
        return new Response(JSON.stringify(session), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    await useChatStore.getState().sendMessage('Hello', { sessionId: 'session-1' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const state = useChatStore.getState()
    const assistantMessage = state.messages.find((message) => message.role === 'assistant')
    assert.equal(state.streaming, false)
    assert.equal(typeof state.assistantRenderId, 'string')
    assert.equal(assistantMessage?.clientRenderId, state.assistantRenderId)
  })

  it('marks the session idle locally as soon as a direct stream finishes', async () => {
    const session = makeSession({ active: true, currentRunId: 'run-1' } as Partial<Session>)
    useAppStore.setState({
      agents: { 'agent-1': makeAgent() },
      sessions: { [session.id]: session },
      currentAgentId: 'agent-1',
    })
    useChatStore.setState({
      messages: [],
      pendingFiles: [],
      replyingTo: null,
      toolEvents: [],
      streamText: '',
      displayText: '',
      streaming: false,
      streamingSessionId: null,
      streamSource: null,
      assistantRenderId: null,
      streamPhase: 'thinking',
      streamToolName: '',
      thinkingText: '',
      thinkingStartTime: 0,
      queuedMessages: [],
      agentStatus: null,
      lastUsage: null,
      hasMoreMessages: false,
      loadingMore: false,
      totalMessages: 0,
    })

    global.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/chats/session-1/chat') {
        return sseResponse([
          { t: 'r', text: 'Done' },
          { t: 'done' },
        ])
      }
      if (url === '/api/chats/session-1') {
        return new Response(JSON.stringify({ ...session, active: false, currentRunId: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    await useChatStore.getState().sendMessage('Hello', { sessionId: 'session-1' })

    const refreshedSession = useAppStore.getState().sessions['session-1']
    assert.equal(refreshedSession?.active, false)
    assert.equal(refreshedSession?.currentRunId, null)
  })

  it('replaces optimistic queued items with the backend queue snapshot', async () => {
    const session = makeSession()
    useAppStore.setState({
      agents: { 'agent-1': makeAgent() },
      sessions: { [session.id]: session },
      currentAgentId: 'agent-1',
    })
    useChatStore.setState({
      messages: [
        { role: 'user', text: 'First', time: 1 },
        { role: 'assistant', text: 'Replying', time: 2 },
      ],
      pendingFiles: [],
      replyingTo: null,
      toolEvents: [],
      streamText: '',
      displayText: '',
      streaming: false,
      streamingSessionId: null,
      streamSource: null,
      assistantRenderId: null,
      streamPhase: 'thinking',
      streamToolName: '',
      thinkingText: '',
      thinkingStartTime: 0,
      queuedMessages: [
        { runId: 'queued-1', sessionId: 'session-1', text: 'Queued hello', queuedAt: Date.now(), position: 0 },
      ],
      agentStatus: null,
      lastUsage: null,
      hasMoreMessages: false,
      loadingMore: false,
      totalMessages: 0,
    })

    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/chats/session-1/queue' && (init?.method || 'GET') === 'POST') {
        return jsonResponse({
          queued: { runId: 'run-queued-1', position: 1 },
          snapshot: {
            sessionId: 'session-1',
            activeRunId: 'run-active',
            queueLength: 1,
            items: [
              { runId: 'run-queued-1', sessionId: 'session-1', text: 'Queued hello', queuedAt: 5, position: 1 },
            ],
          },
        }, 202)
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    await useChatStore.getState().queueMessage('session-1', { text: 'Queued hello' })

    const state = useChatStore.getState()
    assert.equal(state.queuedMessages.length, 1)
    assert.equal(state.queuedMessages[0]?.runId, 'run-queued-1')
    assert.equal(state.queuedMessages[0]?.optimistic, undefined)
    assert.equal(useAppStore.getState().sessions['session-1']?.queuedCount, 1)
    assert.equal(useAppStore.getState().sessions['session-1']?.currentRunId, 'run-active')
  })

  it('sends queued attachment and reply metadata to the backend and hydrates it back into state', async () => {
    const session = makeSession()
    let requestBody: Record<string, unknown> | null = null
    useAppStore.setState({
      agents: { 'agent-1': makeAgent() },
      sessions: { [session.id]: session },
      currentAgentId: 'agent-1',
    })
    useChatStore.setState({
      messages: [],
      pendingFiles: [],
      replyingTo: null,
      toolEvents: [],
      streamText: '',
      displayText: '',
      streaming: false,
      streamingSessionId: null,
      streamSource: null,
      assistantRenderId: null,
      streamPhase: 'thinking',
      streamToolName: '',
      thinkingText: '',
      thinkingStartTime: 0,
      queuedMessages: [],
      agentStatus: null,
      lastUsage: null,
      hasMoreMessages: false,
      loadingMore: false,
      totalMessages: 0,
    })

    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/chats/session-1/queue' && (init?.method || 'GET') === 'POST') {
        requestBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
        return jsonResponse({
          queued: { runId: 'run-queued-meta', position: 1 },
          snapshot: {
            sessionId: 'session-1',
            activeRunId: 'run-active',
            queueLength: 1,
            items: [
              {
                runId: 'run-queued-meta',
                sessionId: 'session-1',
                text: 'Queued with files',
                queuedAt: 12,
                position: 1,
                imagePath: '/tmp/cover.png',
                imageUrl: '/api/uploads/cover.png',
                attachedFiles: ['/tmp/spec.md', '/tmp/notes.txt'],
                replyToId: 'msg-7',
              },
            ],
          },
        }, 202)
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    await useChatStore.getState().queueMessage('session-1', {
      text: 'Queued with files',
      imagePath: '/tmp/cover.png',
      imageUrl: '/api/uploads/cover.png',
      attachedFiles: ['/tmp/spec.md', '/tmp/notes.txt'],
      replyToId: 'msg-7',
    })

    assert.deepEqual(requestBody, {
      message: 'Queued with files',
      imagePath: '/tmp/cover.png',
      imageUrl: '/api/uploads/cover.png',
      attachedFiles: ['/tmp/spec.md', '/tmp/notes.txt'],
      replyToId: 'msg-7',
    })

    const queued = useChatStore.getState().queuedMessages
    assert.equal(queued.length, 1)
    assert.equal(queued[0]?.imagePath, '/tmp/cover.png')
    assert.equal(queued[0]?.imageUrl, '/api/uploads/cover.png')
    assert.deepEqual(queued[0]?.attachedFiles, ['/tmp/spec.md', '/tmp/notes.txt'])
    assert.equal(queued[0]?.replyToId, 'msg-7')
  })

  it('hydrates queued items from the backend queue snapshot', async () => {
    const session = makeSession()
    useAppStore.setState({
      agents: { 'agent-1': makeAgent() },
      sessions: { [session.id]: session },
      currentAgentId: 'agent-1',
    })
    useChatStore.setState({
      messages: [],
      pendingFiles: [],
      replyingTo: null,
      toolEvents: [],
      streamText: '',
      displayText: '',
      streaming: false,
      streamingSessionId: null,
      streamSource: null,
      assistantRenderId: null,
      streamPhase: 'thinking',
      streamToolName: '',
      thinkingText: '',
      thinkingStartTime: 0,
      queuedMessages: [],
      agentStatus: null,
      lastUsage: null,
      hasMoreMessages: false,
      loadingMore: false,
      totalMessages: 0,
    })

    global.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/chats/session-1/queue') {
        return jsonResponse({
          sessionId: 'session-1',
          activeRunId: 'run-active',
          queueLength: 2,
          items: [
            { runId: 'run-queued-2', sessionId: 'session-1', text: 'Resume queue', queuedAt: 10, position: 1 },
            { runId: 'run-queued-3', sessionId: 'session-1', text: 'Then refine it', queuedAt: 11, position: 2 },
          ],
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    await useChatStore.getState().loadQueuedMessages('session-1')

    const state = useChatStore.getState()
    assert.deepEqual(state.queuedMessages.map((item) => item.runId), ['run-queued-2', 'run-queued-3'])
    assert.equal(useAppStore.getState().sessions['session-1']?.queuedCount, 2)
    assert.equal(useAppStore.getState().sessions['session-1']?.currentRunId, 'run-active')
  })

  it('removes optimistic queued items again when the backend enqueue fails', async () => {
    const session = makeSession()
    useAppStore.setState({
      agents: { 'agent-1': makeAgent() },
      sessions: { [session.id]: session },
      currentAgentId: 'agent-1',
    })
    useChatStore.setState({
      messages: [],
      pendingFiles: [],
      replyingTo: null,
      toolEvents: [],
      streamText: '',
      displayText: '',
      streaming: false,
      streamingSessionId: null,
      streamSource: null,
      assistantRenderId: null,
      streamPhase: 'thinking',
      streamToolName: '',
      thinkingText: '',
      thinkingStartTime: 0,
      queuedMessages: [],
      agentStatus: null,
      lastUsage: null,
      hasMoreMessages: false,
      loadingMore: false,
      totalMessages: 0,
    })

    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/chats/session-1/queue' && (init?.method || 'GET') === 'POST') {
        return jsonResponse({ error: 'Queue write failed' }, 500)
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    await assert.rejects(
      useChatStore.getState().queueMessage('session-1', { text: 'Will fail' }),
      /Queue write failed/,
    )

    const state = useChatStore.getState()
    assert.equal(state.queuedMessages.length, 0)
    assert.equal(useAppStore.getState().sessions['session-1']?.queuedCount ?? 0, 0)
  })

  it('preserves the assistant render id across a reconciled message refresh', () => {
    useChatStore.setState({
      messages: [
        { role: 'user', text: 'Hello', time: 1 },
        { role: 'assistant', text: 'Stable final answer', time: 2, clientRenderId: 'render-1' },
      ],
      assistantRenderId: 'render-1',
      toolEvents: [],
      streamText: '',
      displayText: '',
      streaming: false,
      streamingSessionId: null,
      streamSource: null,
      streamPhase: 'thinking',
      streamToolName: '',
      thinkingText: '',
      thinkingStartTime: 0,
      queuedMessages: [],
      agentStatus: null,
      lastUsage: null,
      hasMoreMessages: false,
      loadingMore: false,
      totalMessages: 2,
    })

    useChatStore.getState().setMessages([
      { role: 'user', text: 'Hello', time: 10 },
      { role: 'assistant', text: 'Stable final answer', time: 20 },
    ])

    const state = useChatStore.getState()
    assert.equal(state.assistantRenderId, 'render-1')
    assert.equal(state.messages[1]?.clientRenderId, 'render-1')
  })
})
