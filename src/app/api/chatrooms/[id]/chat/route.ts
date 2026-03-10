import { NextResponse } from 'next/server'
import { genId } from '@/lib/id'
import { loadChatrooms, saveChatrooms, loadAgents } from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'
import { notFound } from '@/lib/server/collection-helpers'
import { streamAgentChat } from '@/lib/server/chat-execution/stream-agent-chat'
import { getProvider } from '@/lib/providers'
import {
  resolveApiKey,
  parseMentions,
  resolveReplyTargetAgentId,
  resolveAgentApiEndpoint,
  compactChatroomMessages,
  buildChatroomSystemPrompt,
  ensureSyntheticSession,
  appendSyntheticSessionMessage,
  buildAgentSystemPromptForChatroom,
  buildHistoryForAgent,
  isMuted,
} from '@/lib/server/chatrooms/chatroom-helpers'
import { filterHealthyChatroomAgents } from '@/lib/server/chatrooms/chatroom-health'
import { evaluateRoutingRules } from '@/lib/server/chatrooms/chatroom-routing'
import { markProviderFailure, markProviderSuccess } from '@/lib/server/provider-health'
import { applyAgentReactionsFromText } from '@/lib/server/chatrooms/chatroom-orchestration'
import { resolvePrimaryAgentRoute } from '@/lib/server/agents/agent-runtime-config'
import { shouldSuppressHiddenControlText, stripHiddenControlTokens } from '@/lib/server/agents/assistant-control'
import type { Chatroom, ChatroomMessage, Agent } from '@/types'
import { errorMessage } from '@/lib/shared-utils'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const MAX_CHAIN_DEPTH = 5

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()

  const chatrooms = loadChatrooms()
  const chatroom = chatrooms[id] as Chatroom | undefined
  if (!chatroom) return notFound()

  const text = typeof body.text === 'string' ? body.text : ''
  const senderId = typeof body.senderId === 'string' ? body.senderId : 'user'
  const imagePath = typeof body.imagePath === 'string' ? body.imagePath : undefined
  const attachedFiles = Array.isArray(body.attachedFiles)
    ? (body.attachedFiles as unknown[]).filter((f): f is string => typeof f === 'string')
    : undefined
  const replyToId = typeof body.replyToId === 'string' ? body.replyToId : undefined

  if (!text.trim() && !imagePath && !attachedFiles?.length) {
    return NextResponse.json({ error: 'text or attachment is required' }, { status: 400 })
  }

  const agents = loadAgents() as Record<string, Agent>

  // Persist incoming message
  const senderName = senderId === 'user' ? 'You' : (agents[senderId]?.name || senderId)
  const replyTargetAgentId = resolveReplyTargetAgentId(replyToId, chatroom.messages, chatroom.agentIds)
  let mentions = parseMentions(text, agents, chatroom.agentIds, { replyTargetAgentId })
  // Routing rules: if no explicit mentions, evaluate keyword/capability rules
  if (mentions.length === 0 && chatroom.routingRules?.length) {
    const agentList = chatroom.agentIds.map((aid) => agents[aid]).filter(Boolean)
    mentions = evaluateRoutingRules(text, chatroom.routingRules, agentList)
  }
  // Auto-address: if enabled and still no mentions, address all agents
  if (chatroom.autoAddress && mentions.length === 0) {
    mentions = [...chatroom.agentIds]
  }
  const mentionHealth = filterHealthyChatroomAgents(mentions, agents)
  mentions = mentionHealth.healthyAgentIds
  const userMessage: ChatroomMessage = {
    id: genId(),
    senderId,
    senderName,
    role: senderId === 'user' ? 'user' : 'assistant',
    text,
    mentions,
    reactions: [],
    time: Date.now(),
    ...(imagePath ? { imagePath } : {}),
    ...(attachedFiles ? { attachedFiles } : {}),
    ...(replyToId ? { replyToId } : {}),
  }
  chatroom.messages.push(userMessage)
  compactChatroomMessages(chatroom)
  chatroom.updatedAt = Date.now()
  chatrooms[id] = chatroom
  saveChatrooms(chatrooms)
  notify('chatrooms')
  notify(`chatroom:${id}`)

  // Build reply context if replying to a message
  let replyContext = ''
  if (replyToId) {
    const replyMsg = chatroom.messages.find((m) => m.id === replyToId)
    if (replyMsg) {
      const truncated = replyMsg.text.length > 200 ? replyMsg.text.slice(0, 200) + '...' : replyMsg.text
      replyContext = `> [${replyMsg.senderName}]: ${truncated}\n\n`
    }
  }

  // SSE stream
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      let closed = false
      const writeEvent = (event: Record<string, unknown>) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        } catch {
          closed = true
        }
      }

      const processAgents = async () => {
        if (mentionHealth.skipped.length > 0) {
          const detail = mentionHealth.skipped
            .map((row) => `${agents[row.agentId]?.name || row.agentId}: ${row.reason}`)
            .join(', ')
          writeEvent({ t: 'err', text: `Skipped agents: ${detail}` })
        }
        if (mentions.length === 0) {
          writeEvent({ t: 'err', text: 'No healthy agents available in this chatroom. Check provider credentials/endpoints and retry.' })
          writeEvent({ t: 'done' })
          if (!closed) {
            try { controller.close() } catch { /* already closed */ }
            closed = true
          }
          return
        }

        // Build agent queue: start with mentioned agents, then chain
        const initialQueue: Array<{ agentId: string; depth: number; contextMessage?: string }> = mentions.map((aid) => ({ agentId: aid, depth: 0 }))
        const processed = new Set<string>()
        const agentQueue: Array<{ agentId: string; depth: number; contextMessage?: string }> = []

        /** Process a single agent: stream response, persist message, return chained mentions */
        const processOneAgent = async (item: { agentId: string; depth: number; contextMessage?: string }): Promise<string[]> => {
          if (processed.has(item.agentId) || item.depth >= MAX_CHAIN_DEPTH) return []
          processed.add(item.agentId)

          const agent = agents[item.agentId]
          if (!agent) return []

          // Skip muted agents
          const freshForMuteCheck = loadChatrooms()[id] as Chatroom | undefined
          if (freshForMuteCheck && isMuted(freshForMuteCheck, item.agentId)) {
            writeEvent({ t: 'cr_agent_start', agentId: agent.id, agentName: agent.name })
            writeEvent({ t: 'err', text: `${agent.name} is muted`, agentId: agent.id, agentName: agent.name })
            writeEvent({ t: 'cr_agent_done', agentId: agent.id, agentName: agent.name })
            return []
          }

          // Pre-flight: check if the agent's provider is usable before attempting to stream
          const route = resolvePrimaryAgentRoute(agent)
          const providerInfo = getProvider(route?.provider || agent.provider)
          const apiKey = resolveApiKey(route?.credentialId || agent.credentialId)
          const resolvedEndpoint = route?.apiEndpoint || resolveAgentApiEndpoint(agent)
          if (providerInfo?.requiresApiKey && !apiKey) {
            writeEvent({ t: 'cr_agent_start', agentId: agent.id, agentName: agent.name })
            writeEvent({ t: 'err', text: `${agent.name} has no API credentials configured`, agentId: agent.id, agentName: agent.name })
            writeEvent({ t: 'cr_agent_done', agentId: agent.id, agentName: agent.name })
            return []
          }
          if (providerInfo?.requiresEndpoint && !resolvedEndpoint) {
            writeEvent({ t: 'cr_agent_start', agentId: agent.id, agentName: agent.name })
            writeEvent({ t: 'err', text: `${agent.name} has no endpoint configured`, agentId: agent.id, agentName: agent.name })
            writeEvent({ t: 'cr_agent_done', agentId: agent.id, agentName: agent.name })
            return []
          }

          writeEvent({ t: 'cr_agent_start', agentId: agent.id, agentName: agent.name })

          try {
            const freshChatrooms = loadChatrooms()
            const freshChatroom = freshChatrooms[id] as Chatroom
            if (compactChatroomMessages(freshChatroom)) {
              freshChatrooms[id] = freshChatroom
              saveChatrooms(freshChatrooms)
              notify(`chatroom:${id}`)
            }

            const syntheticSession = ensureSyntheticSession(agent, id)
            syntheticSession.provider = route?.provider || syntheticSession.provider
            syntheticSession.model = route?.model || syntheticSession.model
            syntheticSession.credentialId = route?.credentialId ?? syntheticSession.credentialId ?? null
            syntheticSession.fallbackCredentialIds = route?.fallbackCredentialIds || syntheticSession.fallbackCredentialIds || []
            syntheticSession.gatewayProfileId = route?.gatewayProfileId ?? syntheticSession.gatewayProfileId ?? null
            syntheticSession.apiEndpoint = resolvedEndpoint
            const agentSystemPrompt = buildAgentSystemPromptForChatroom(agent)
            const chatroomContext = buildChatroomSystemPrompt(freshChatroom, agents, agent.id)
            const fullSystemPrompt = [agentSystemPrompt, chatroomContext].filter(Boolean).join('\n\n')
            const history = buildHistoryForAgent(freshChatroom, agent.id, imagePath, attachedFiles)

            // Use enriched context message for chained agents, or reply context + original text
            const messageForAgent = item.contextMessage || (replyContext + text)
            appendSyntheticSessionMessage(syntheticSession.id, 'user', messageForAgent)

            let fullText = ''
            let agentError = ''
            const result = await streamAgentChat({
              session: syntheticSession,
              message: messageForAgent,
              imagePath,
              attachedFiles,
              apiKey,
              systemPrompt: fullSystemPrompt,
              write: (raw: string) => {
                const lines = raw.split('\n').filter(Boolean)
                for (const line of lines) {
                  if (!line.startsWith('data: ')) continue
                  try {
                    const parsed = JSON.parse(line.slice(6).trim())
                    if (parsed.t === 'd' && parsed.text) {
                      fullText += parsed.text
                      writeEvent({ t: 'd', text: parsed.text, agentId: agent.id, agentName: agent.name })
                    } else if (parsed.t === 'tool_call' || parsed.t === 'tool_result') {
                      writeEvent({ ...parsed, agentId: agent.id, agentName: agent.name })
                    } else if (parsed.t === 'err' && parsed.text) {
                      agentError = parsed.text
                      writeEvent({ t: 'err', text: parsed.text, agentId: agent.id, agentName: agent.name })
                    }
                  } catch {
                    // skip malformed lines
                  }
                }
              },
              history,
            })

            const rawResponseText = result.finalResponse || result.fullText || fullText
            const responseText = stripHiddenControlTokens(rawResponseText)

            // Don't persist empty or error-only messages — they pollute chat history
            if (!responseText.trim() && agentError) {
              appendSyntheticSessionMessage(syntheticSession.id, 'assistant', agentError)
              markProviderFailure(agent.provider, agentError)
              writeEvent({ t: 'cr_agent_done', agentId: agent.id, agentName: agent.name })
              return []
            }

            if (responseText.trim() && !shouldSuppressHiddenControlText(rawResponseText)) {
              appendSyntheticSessionMessage(syntheticSession.id, 'assistant', responseText)
              const parsedMentions = parseMentions(responseText, agents, freshChatroom.agentIds)
              const chainedHealth = filterHealthyChatroomAgents(parsedMentions, agents)
              const newMentions = chainedHealth.healthyAgentIds
              if (chainedHealth.skipped.length > 0) {
                const detail = chainedHealth.skipped
                  .map((row) => `${agents[row.agentId]?.name || row.agentId}: ${row.reason}`)
                  .join(', ')
                writeEvent({ t: 'err', text: `Mentioned agents skipped: ${detail}`, agentId: agent.id, agentName: agent.name })
              }
              const agentMessage: ChatroomMessage = {
                id: genId(),
                senderId: agent.id,
                senderName: agent.name,
                role: 'assistant',
                text: responseText,
                mentions: newMentions,
                reactions: [],
                time: Date.now(),
              }
              const latestChatrooms = loadChatrooms()
              const latestChatroom = latestChatrooms[id] as Chatroom
              latestChatroom.messages.push(agentMessage)
              latestChatroom.updatedAt = Date.now()
              latestChatrooms[id] = latestChatroom
              saveChatrooms(latestChatrooms)
              notify(`chatroom:${id}`)

              // Extract and apply reactions (e.g. [REACTION]{"emoji":"👍","to":"..."})
              applyAgentReactionsFromText(responseText, id, agent.id)

              markProviderSuccess(agent.provider)
              writeEvent({ t: 'cr_agent_done', agentId: agent.id, agentName: agent.name })

              // Return chained agent IDs — enriched context is built below when queuing
              return newMentions.filter((mid) => !processed.has(mid) && freshChatroom.agentIds.includes(mid))
            }

            markProviderSuccess(agent.provider)
            writeEvent({ t: 'cr_agent_done', agentId: agent.id, agentName: agent.name })
            return []
          } catch (err: unknown) {
            const msg = errorMessage(err)
            markProviderFailure(agent.provider, msg)
            writeEvent({ t: 'err', text: `Agent ${agent.name} error: ${msg}`, agentId: agent.id })
            writeEvent({ t: 'cr_agent_done', agentId: agent.id, agentName: agent.name })
            return []
          }
        }

        if (chatroom.chatMode === 'parallel') {
          // Process initial batch in parallel
          const results = await Promise.all(initialQueue.map(processOneAgent))
          // Chained agents from parallel responses queue sequentially
          for (const chainedIds of results) {
            for (const cid of chainedIds) {
              agentQueue.push({ agentId: cid, depth: 1 })
            }
          }
        } else {
          // Sequential: push initial queue items
          agentQueue.push(...initialQueue)
        }

        // Process remaining chained agents sequentially with enriched context
        while (agentQueue.length > 0) {
          const item = agentQueue.shift()!

          // Build enriched context for chained agents by looking at the most recent message
          if (item.depth > 0 && !item.contextMessage) {
            const latestChatrooms = loadChatrooms()
            const latestChatroom = latestChatrooms[id] as Chatroom
            const lastAgentMsg = [...latestChatroom.messages].reverse().find(
              (m) => m.role === 'assistant' && m.senderId !== item.agentId
            )
            if (lastAgentMsg) {
              const truncated = lastAgentMsg.text.length > 500 ? lastAgentMsg.text.slice(0, 500) + '...' : lastAgentMsg.text
              item.contextMessage = `${lastAgentMsg.senderName} said: "${truncated}" — They're requesting your help. Review the conversation and respond.`
            }
          }

          const chainedIds = await processOneAgent(item)
          for (const cid of chainedIds) {
            agentQueue.push({ agentId: cid, depth: item.depth + 1 })
          }
        }

        writeEvent({ t: 'done' })
        if (!closed) {
          try { controller.close() } catch { /* already closed */ }
          closed = true
        }
      }

      processAgents().catch((err) => {
        const msg = errorMessage(err)
        writeEvent({ t: 'err', text: msg })
        writeEvent({ t: 'done' })
        if (!closed) {
          try { controller.close() } catch { /* already closed */ }
          closed = true
        }
      })
    },
    cancel() {
      // Client disconnected
    },
  })

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
