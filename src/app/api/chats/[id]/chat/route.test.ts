import assert from 'node:assert/strict'
import test from 'node:test'

import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

test('chat route keeps long-lived user runs alive after stream disconnect and records perf', () => {
  const output = runWithTempDataDir<{
    responseReturnedBeforeProviderFinished: boolean
    firstChunk: string
    assistantReplies: string[]
    runStatuses: string[]
    queueLength: number
    perfLabels: string[]
  }>(`
    const storageMod = await import('./src/lib/server/storage')
    const providersMod = await import('@/lib/providers')
    const routeMod = await import('./src/app/api/chats/[id]/chat/route')
    const runsMod = await import('@/lib/server/runtime/session-run-manager')
    const perfMod = await import('@/lib/server/runtime/perf')
    const storage = storageMod.default || storageMod
    const providers = providersMod.default || providersMod
    const route = routeMod.default || routeMod
    const runs = runsMod.default || runsMod
    const perf = perfMod.perf || perfMod.default?.perf || perfMod.default || perfMod

    let providerFinishedAt = 0
    providers.PROVIDERS['workbench-provider'] = {
      id: 'workbench-provider',
      name: 'Workbench Provider',
      models: ['wb-model'],
      requiresApiKey: false,
      requiresEndpoint: false,
      handler: {
        streamChat: async (opts) => {
          await new Promise((resolve) => setTimeout(resolve, 120))
          const reply = 'Long-lived work finished cleanly.'
          opts.write('data: ' + JSON.stringify({ t: 'r', text: reply }) + '\\n')
          providerFinishedAt = Date.now()
          return reply
        },
      },
    }

    const now = Date.now()
    storage.saveAgents({
      agent_1: {
        id: 'agent_1',
        name: 'Workbench Agent',
        provider: 'workbench-provider',
        model: 'wb-model',
        plugins: [],
        createdAt: now,
        updatedAt: now,
      },
    })
    storage.saveSessions({
      sess_1: {
        id: 'sess_1',
        name: 'Workbench Session',
        cwd: process.env.WORKSPACE_DIR,
        user: 'workbench',
        provider: 'workbench-provider',
        model: 'wb-model',
        claudeSessionId: null,
        messages: [],
        createdAt: now,
        lastActiveAt: now,
        sessionType: 'human',
        agentId: 'agent_1',
        plugins: [],
      },
    })

    perf.setEnabled(true)
    perf.clearRecentEntries()

    const startedAt = Date.now()
    const response = await route.POST(
      new Request('http://local/api/chats/sess_1/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'Please run the long-lived task.' }),
      }),
      { params: Promise.resolve({ id: 'sess_1' }) },
    )
    const returnedAt = Date.now()

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const firstRead = await reader.read()
    const firstChunk = decoder.decode(firstRead.value || new Uint8Array())
    await reader.cancel()

    await new Promise((resolve) => setTimeout(resolve, 220))

    const session = storage.loadSessions().sess_1
    const assistantReplies = (session.messages || [])
      .filter((entry) => entry.role === 'assistant')
      .map((entry) => entry.text)
    const runStatuses = runs.listRuns({ sessionId: 'sess_1' }).map((entry) => entry.status)
    const queueState = runs.getSessionExecutionState('sess_1')
    const perfLabels = perf.getRecentEntries()
      .filter((entry) => entry.category === 'chat-execution' || entry.category === 'queue')
      .map((entry) => entry.category + '/' + entry.label)

    console.log(JSON.stringify({
      responseReturnedBeforeProviderFinished: providerFinishedAt > 0 && returnedAt < providerFinishedAt,
      firstChunk,
      assistantReplies,
      runStatuses,
      queueLength: queueState.queueLength,
      perfLabels,
      responseLatencyMs: returnedAt - startedAt,
    }))
  `, { prefix: 'swarmclaw-chat-route-test-' })

  assert.equal(output.responseReturnedBeforeProviderFinished, true)
  assert.match(output.firstChunk, /\\"status\\":\\"queued\\"/)
  assert.deepEqual(output.assistantReplies, ['Long-lived work finished cleanly.'])
  assert.ok(output.runStatuses.includes('completed'))
  assert.equal(output.queueLength, 0)
  assert.ok(output.perfLabels.includes('chat-execution/executeSessionChatTurn'))
  assert.ok(output.perfLabels.includes('chat-execution/llm-round-trip'))
})

test('chat route heartbeat runs stay internal and do not persist terminal ack text', () => {
  const output = runWithTempDataDir<{
    events: Array<{ t?: string; text?: string }>
    assistantReplies: string[]
    queueLength: number
  }>(`
    const storageMod = await import('./src/lib/server/storage')
    const providersMod = await import('@/lib/providers')
    const routeMod = await import('./src/app/api/chats/[id]/chat/route')
    const runsMod = await import('@/lib/server/runtime/session-run-manager')
    const storage = storageMod.default || storageMod
    const providers = providersMod.default || providersMod
    const route = routeMod.default || routeMod
    const runs = runsMod.default || runsMod

    providers.PROVIDERS['heartbeat-provider'] = {
      id: 'heartbeat-provider',
      name: 'Heartbeat Provider',
      models: ['hb-model'],
      requiresApiKey: false,
      requiresEndpoint: false,
      handler: {
        streamChat: async (opts) => {
          opts.write('data: ' + JSON.stringify({ t: 'r', text: 'HEARTBEAT_OK' }) + '\\n')
          return 'HEARTBEAT_OK'
        },
      },
    }

    const now = Date.now()
    storage.saveAgents({
      agent_1: {
        id: 'agent_1',
        name: 'Heartbeat Agent',
        provider: 'heartbeat-provider',
        model: 'hb-model',
        plugins: [],
        heartbeatEnabled: true,
        createdAt: now,
        updatedAt: now,
      },
    })
    storage.saveSessions({
      sess_1: {
        id: 'sess_1',
        name: 'Heartbeat Session',
        cwd: process.env.WORKSPACE_DIR,
        user: 'workbench',
        provider: 'heartbeat-provider',
        model: 'hb-model',
        claudeSessionId: null,
        messages: [],
        createdAt: now,
        lastActiveAt: now,
        sessionType: 'human',
        agentId: 'agent_1',
        heartbeatEnabled: true,
        plugins: [],
      },
    })

    async function readSse(response) {
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const events = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx = buffer.indexOf('\\n\\n')
        while (idx !== -1) {
          const chunk = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const line = chunk
            .split('\\n')
            .map((entry) => entry.trim())
            .find((entry) => entry.startsWith('data: '))
          if (line) {
            events.push(JSON.parse(line.slice(6)))
          }
          idx = buffer.indexOf('\\n\\n')
        }
      }
      return events
    }

    const response = await route.POST(
      new Request('http://local/api/chats/sess_1/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'SWARM_HEARTBEAT_CHECK', internal: true }),
      }),
      { params: Promise.resolve({ id: 'sess_1' }) },
    )

    const events = await readSse(response)
    const session = storage.loadSessions().sess_1
    const assistantReplies = (session.messages || [])
      .filter((entry) => entry.role === 'assistant')
      .map((entry) => entry.text)

    console.log(JSON.stringify({
      events,
      assistantReplies,
      queueLength: runs.getSessionExecutionState('sess_1').queueLength,
    }))
  `, { prefix: 'swarmclaw-chat-route-heartbeat-' })

  assert.equal(output.events[0]?.t, 'md')
  assert.match(String(output.events[0]?.text || ''), /"internal":true/)
  assert.match(String(output.events[0]?.text || ''), /"source":"heartbeat"/)
  assert.equal(output.events.at(-1)?.t, 'done')
  assert.equal(output.assistantReplies.some((text) => /HEARTBEAT_OK/i.test(text)), false)
  assert.equal(output.queueLength, 0)
})

test('chat route queues a second user message behind the first run and completes both in order', () => {
  const output = runWithTempDataDir<{
    firstRunMeta: string
    secondRunMeta: string
    assistantReplies: string[]
    runStatuses: string[]
  }>(`
    const storageMod = await import('./src/lib/server/storage')
    const providersMod = await import('@/lib/providers')
    const routeMod = await import('./src/app/api/chats/[id]/chat/route')
    const runsMod = await import('@/lib/server/runtime/session-run-manager')
    const storage = storageMod.default || storageMod
    const providers = providersMod.default || providersMod
    const route = routeMod.default || routeMod
    const runs = runsMod.default || runsMod

    providers.PROVIDERS['queue-provider'] = {
      id: 'queue-provider',
      name: 'Queue Provider',
      models: ['queue-model'],
      requiresApiKey: false,
      requiresEndpoint: false,
      handler: {
        streamChat: async (opts) => {
          await new Promise((resolve) => setTimeout(resolve, 80))
          const reply = 'Completed: ' + opts.message
          opts.write('data: ' + JSON.stringify({ t: 'r', text: reply }) + '\\n')
          return reply
        },
      },
    }

    const now = Date.now()
    storage.saveAgents({
      agent_1: {
        id: 'agent_1',
        name: 'Queue Agent',
        provider: 'queue-provider',
        model: 'queue-model',
        plugins: [],
        createdAt: now,
        updatedAt: now,
      },
    })
    storage.saveSessions({
      sess_1: {
        id: 'sess_1',
        name: 'Queued Session',
        cwd: process.env.WORKSPACE_DIR,
        user: 'workbench',
        provider: 'queue-provider',
        model: 'queue-model',
        claudeSessionId: null,
        messages: [],
        createdAt: now,
        lastActiveAt: now,
        sessionType: 'human',
        agentId: 'agent_1',
        plugins: [],
      },
    })

    async function readSse(response) {
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const events = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx = buffer.indexOf('\\n\\n')
        while (idx !== -1) {
          const chunk = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const line = chunk
            .split('\\n')
            .map((entry) => entry.trim())
            .find((entry) => entry.startsWith('data: '))
          if (line) {
            events.push(JSON.parse(line.slice(6)))
          }
          idx = buffer.indexOf('\\n\\n')
        }
      }
      return events
    }

    const response1 = await route.POST(
      new Request('http://local/api/chats/sess_1/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'first queued message' }),
      }),
      { params: Promise.resolve({ id: 'sess_1' }) },
    )
    const response2 = await route.POST(
      new Request('http://local/api/chats/sess_1/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'second queued message' }),
      }),
      { params: Promise.resolve({ id: 'sess_1' }) },
    )

    const [events1, events2] = await Promise.all([readSse(response1), readSse(response2)])
    const session = storage.loadSessions().sess_1
    const assistantReplies = (session.messages || [])
      .filter((entry) => entry.role === 'assistant')
      .map((entry) => entry.text)
    console.log(JSON.stringify({
      firstRunMeta: events1.find((entry) => entry.t === 'md')?.text || '',
      secondRunMeta: events2.find((entry) => entry.t === 'md')?.text || '',
      assistantReplies,
      runStatuses: runs.listRuns({ sessionId: 'sess_1' }).map((entry) => entry.status),
    }))
  `, { prefix: 'swarmclaw-chat-route-plugins-' })

  assert.match(output.firstRunMeta, /"position":0/)
  assert.match(output.secondRunMeta, /"position":1/)
  assert.deepEqual(output.assistantReplies, [
    'Completed: first queued message',
    'Completed: second queued message',
  ])
  assert.deepEqual(output.runStatuses, ['completed', 'completed'])
})

test('chat route forwards plugin-path tool activity when a plugin-enabled run uses streamAgentChat', () => {
  const output = runWithTempDataDir<{
    toolCalls: string[]
    toolResults: string[]
    assistantReplies: string[]
  }>(`
    const storageMod = await import('./src/lib/server/storage')
    const providersMod = await import('@/lib/providers')
    const routeMod = await import('./src/app/api/chats/[id]/chat/route')
    const streamMod = await import('@/lib/server/chat-execution/stream-agent-chat')
    const storage = storageMod.default || storageMod
    const providers = providersMod.default || providersMod
    const route = routeMod.default || routeMod
    const stream = streamMod.default || streamMod

    providers.PROVIDERS['plugin-provider'] = {
      id: 'plugin-provider',
      name: 'Plugin Provider',
      models: ['plugin-model'],
      requiresApiKey: false,
      requiresEndpoint: false,
      handler: { streamChat: async () => '' },
    }

    const now = Date.now()
    storage.saveAgents({
      agent_1: {
        id: 'agent_1',
        name: 'Plugin Agent',
        provider: 'plugin-provider',
        model: 'plugin-model',
        plugins: ['web'],
        createdAt: now,
        updatedAt: now,
      },
    })
    storage.saveSessions({
      sess_1: {
        id: 'sess_1',
        name: 'Plugin Session',
        cwd: process.env.WORKSPACE_DIR,
        user: 'workbench',
        provider: 'plugin-provider',
        model: 'plugin-model',
        claudeSessionId: null,
        messages: [],
        createdAt: now,
        lastActiveAt: now,
        sessionType: 'human',
        agentId: 'agent_1',
        plugins: ['web'],
      },
    })

    async function readSse(response) {
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const events = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx = buffer.indexOf('\\n\\n')
        while (idx !== -1) {
          const chunk = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const line = chunk
            .split('\\n')
            .map((entry) => entry.trim())
            .find((entry) => entry.startsWith('data: '))
          if (line) {
            events.push(JSON.parse(line.slice(6)))
          }
          idx = buffer.indexOf('\\n\\n')
        }
      }
      return events
    }

    stream.setStreamAgentChatForTest(async (opts) => {
      opts.write('data: ' + JSON.stringify({
        t: 'tool_call',
        toolName: 'web',
        toolInput: JSON.stringify({ q: 'queue health' }),
        toolCallId: 'tool-1',
      }) + '\\n')
      opts.write('data: ' + JSON.stringify({
        t: 'tool_result',
        toolName: 'web',
        toolOutput: 'Fetched queue health summary',
        toolCallId: 'tool-1',
      }) + '\\n')
      const reply = 'Queue looks healthy and no plugin errors were observed.'
      opts.write('data: ' + JSON.stringify({ t: 'r', text: reply }) + '\\n')
      return { fullText: reply, finalResponse: reply }
    })

    try {
      const response = await route.POST(
        new Request('http://local/api/chats/sess_1/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'Check queue health with tools.' }),
        }),
        { params: Promise.resolve({ id: 'sess_1' }) },
      )

      const events = await readSse(response)
      const session = storage.loadSessions().sess_1
      const assistantReplies = (session.messages || [])
        .filter((entry) => entry.role === 'assistant')
        .map((entry) => entry.text)
      console.log(JSON.stringify({
        toolCalls: events.filter((entry) => entry.t === 'tool_call').map((entry) => entry.toolName),
        toolResults: events.filter((entry) => entry.t === 'tool_result').map((entry) => entry.toolOutput),
        assistantReplies,
      }))
    } finally {
      stream.setStreamAgentChatForTest(null)
    }
  `, { prefix: 'swarmclaw-chat-route-plugin-events-' })

  assert.deepEqual(output.toolCalls, ['web'])
  assert.deepEqual(output.toolResults, ['Fetched queue health summary'])
  assert.deepEqual(output.assistantReplies, ['Queue looks healthy and no plugin errors were observed.'])
})
