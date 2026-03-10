import assert from 'node:assert/strict'
import test from 'node:test'

import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

test('chatroom route prevents duplicate chained replies when an already-queued agent is re-mentioned', () => {
  const output = runWithTempDataDir<{
    assistantCounts: Record<string, number>
    startCounts: Record<string, number>
    doneCounts: Record<string, number>
    messageTexts: string[]
  }>(`
    const storageMod = await import('./src/lib/server/storage')
    const providersMod = await import('@/lib/providers')
    const routeMod = await import('./src/app/api/chatrooms/[id]/chat/route')
    const streamMod = await import('@/lib/server/chat-execution/stream-agent-chat')
    const storage = storageMod.default || storageMod
    const providers = providersMod.default || providersMod
    const route = routeMod.default || routeMod
    const stream = streamMod.default || streamMod

    providers.PROVIDERS['chatroom-provider'] = {
      id: 'chatroom-provider',
      name: 'Chatroom Provider',
      models: ['room-model'],
      requiresApiKey: false,
      requiresEndpoint: false,
      handler: { streamChat: async () => '' },
    }

    const now = Date.now()
    storage.saveAgents({
      alpha: {
        id: 'alpha',
        name: 'Alpha',
        provider: 'chatroom-provider',
        model: 'room-model',
        plugins: [],
        createdAt: now,
        updatedAt: now,
      },
      beta: {
        id: 'beta',
        name: 'Beta',
        provider: 'chatroom-provider',
        model: 'room-model',
        plugins: [],
        createdAt: now,
        updatedAt: now,
      },
    })
    storage.saveChatrooms({
      room_1: {
        id: 'room_1',
        name: 'Workbench Room',
        agentIds: ['alpha', 'beta'],
        messages: [],
        createdAt: now,
        updatedAt: now,
        chatMode: 'sequential',
        autoAddress: false,
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
      const agentId = opts.session?.agentId
      if (agentId === 'alpha') {
        const reply = '@Beta please double-check this. Alpha found the first issue.'
        opts.write('data: ' + JSON.stringify({ t: 'r', text: reply }) + '\\n')
        return { fullText: reply, finalResponse: reply }
      }
      if (agentId === 'beta') {
        const reply = 'Beta checked it and confirmed the fix.'
        opts.write('data: ' + JSON.stringify({ t: 'r', text: reply }) + '\\n')
        return { fullText: reply, finalResponse: reply }
      }
      return { fullText: '', finalResponse: '' }
    })

    try {
      const response = await route.POST(
        new Request('http://local/api/chatrooms/room_1/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ senderId: 'user', text: '@Alpha @Beta coordinate on this fix.' }),
        }),
        { params: Promise.resolve({ id: 'room_1' }) },
      )

      const events = await readSse(response)
      const chatroom = storage.loadChatrooms().room_1
      const assistantMessages = chatroom.messages.filter((entry) => entry.role === 'assistant')
      const assistantCounts = assistantMessages.reduce((acc, entry) => {
        acc[entry.senderId] = (acc[entry.senderId] || 0) + 1
        return acc
      }, {})
      const startCounts = events
        .filter((entry) => entry.t === 'cr_agent_start')
        .reduce((acc, entry) => {
          acc[entry.agentId] = (acc[entry.agentId] || 0) + 1
          return acc
        }, {})
      const doneCounts = events
        .filter((entry) => entry.t === 'cr_agent_done')
        .reduce((acc, entry) => {
          acc[entry.agentId] = (acc[entry.agentId] || 0) + 1
          return acc
        }, {})

      console.log(JSON.stringify({
        assistantCounts,
        startCounts,
        doneCounts,
        messageTexts: assistantMessages.map((entry) => entry.text),
      }))
    } finally {
      stream.setStreamAgentChatForTest(null)
    }
  `, { prefix: 'swarmclaw-chatroom-route-test-' })

  assert.deepEqual(output.assistantCounts, { alpha: 1, beta: 1 })
  assert.deepEqual(output.startCounts, { alpha: 1, beta: 1 })
  assert.deepEqual(output.doneCounts, { alpha: 1, beta: 1 })
  assert.equal(output.messageTexts.some((text) => /double-check/i.test(text)), true)
  assert.equal(output.messageTexts.some((text) => /confirmed the fix/i.test(text)), true)
})

test('chatroom route forwards tool activity and records one reply per participating agent', () => {
  const output = runWithTempDataDir<{
    toolCalls: string[]
    toolResults: string[]
    assistantCounts: Record<string, number>
    agentOrder: string[]
  }>(`
    const storageMod = await import('./src/lib/server/storage')
    const providersMod = await import('@/lib/providers')
    const routeMod = await import('./src/app/api/chatrooms/[id]/chat/route')
    const streamMod = await import('@/lib/server/chat-execution/stream-agent-chat')
    const storage = storageMod.default || storageMod
    const providers = providersMod.default || providersMod
    const route = routeMod.default || routeMod
    const stream = streamMod.default || streamMod

    providers.PROVIDERS['chatroom-tool-provider'] = {
      id: 'chatroom-tool-provider',
      name: 'Chatroom Tool Provider',
      models: ['room-tool-model'],
      requiresApiKey: false,
      requiresEndpoint: false,
      handler: { streamChat: async () => '' },
    }

    const now = Date.now()
    storage.saveAgents({
      alpha: {
        id: 'alpha',
        name: 'Alpha',
        provider: 'chatroom-tool-provider',
        model: 'room-tool-model',
        plugins: ['shell'],
        createdAt: now,
        updatedAt: now,
      },
      beta: {
        id: 'beta',
        name: 'Beta',
        provider: 'chatroom-tool-provider',
        model: 'room-tool-model',
        plugins: ['shell'],
        createdAt: now,
        updatedAt: now,
      },
    })
    storage.saveChatrooms({
      room_1: {
        id: 'room_1',
        name: 'Parallel Workbench Room',
        agentIds: ['alpha', 'beta'],
        messages: [],
        createdAt: now,
        updatedAt: now,
        chatMode: 'parallel',
        autoAddress: true,
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
      const agentId = opts.session?.agentId
      if (agentId === 'alpha') {
        opts.write('data: ' + JSON.stringify({
          t: 'tool_call',
          toolName: 'shell',
          toolInput: 'pwd',
          toolCallId: 'alpha-shell',
        }) + '\\n')
        opts.write('data: ' + JSON.stringify({
          t: 'tool_result',
          toolName: 'shell',
          toolOutput: process.env.WORKSPACE_DIR,
          toolCallId: 'alpha-shell',
        }) + '\\n')
        const reply = 'Alpha inspected the workspace root and found the repo is ready.'
        opts.write('data: ' + JSON.stringify({ t: 'r', text: reply }) + '\\n')
        return { fullText: reply, finalResponse: reply }
      }
      if (agentId === 'beta') {
        const reply = 'Beta reviewed the plugin path and agrees with Alpha.'
        opts.write('data: ' + JSON.stringify({ t: 'r', text: reply }) + '\\n')
        return { fullText: reply, finalResponse: reply }
      }
      return { fullText: '', finalResponse: '' }
    })

    try {
      const response = await route.POST(
        new Request('http://local/api/chatrooms/room_1/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ senderId: 'user', text: 'Please inspect the workspace and plugin path.' }),
        }),
        { params: Promise.resolve({ id: 'room_1' }) },
      )

      const events = await readSse(response)
      const chatroom = storage.loadChatrooms().room_1
      const assistantMessages = chatroom.messages.filter((entry) => entry.role === 'assistant')
      const assistantCounts = assistantMessages.reduce((acc, entry) => {
        acc[entry.senderId] = (acc[entry.senderId] || 0) + 1
        return acc
      }, {})

      console.log(JSON.stringify({
        toolCalls: events.filter((entry) => entry.t === 'tool_call').map((entry) => entry.toolName),
        toolResults: events.filter((entry) => entry.t === 'tool_result').map((entry) => entry.toolOutput),
        assistantCounts,
        agentOrder: assistantMessages.map((entry) => entry.senderId),
      }))
    } finally {
      stream.setStreamAgentChatForTest(null)
    }
  `, { prefix: 'swarmclaw-chatroom-route-tools-' })

  assert.deepEqual(output.toolCalls, ['shell'])
  assert.equal(output.toolResults.length, 1)
  assert.deepEqual(output.assistantCounts, { alpha: 1, beta: 1 })
  assert.deepEqual([...new Set(output.agentOrder)].sort(), ['alpha', 'beta'])
})
