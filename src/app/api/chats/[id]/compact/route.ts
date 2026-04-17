import { NextResponse } from 'next/server'
import { z } from 'zod'
import { HumanMessage } from '@langchain/core/messages'
import { getSession } from '@/lib/server/sessions/session-repository'
import { getMessages, replaceAllMessages } from '@/lib/server/messages/message-repository'
import { summarizeAndCompact, type LLMSummarizer } from '@/lib/server/context-manager'
import { buildChatModel } from '@/lib/server/build-llm'
import { notFound } from '@/lib/server/collection-helpers'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import { errorMessage } from '@/lib/shared-utils'

const BodySchema = z.object({
  keepLastN: z.number().int().min(2).max(200).optional(),
}).partial()

const DEFAULT_KEEP_LAST_N = 10

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = getSession(id)
  if (!session) return notFound()

  const parsed = await safeParseBody(req, BodySchema)
  if (parsed.error) return parsed.error
  const keepLastN = Math.max(2, Math.min(parsed.data.keepLastN ?? DEFAULT_KEEP_LAST_N, 200))

  const messages = getMessages(id)
  if (messages.length <= keepLastN) {
    return NextResponse.json({
      status: 'no_action',
      messageCount: messages.length,
      keepLastN,
    })
  }

  const generateSummary: LLMSummarizer = async (prompt) => {
    const llm = buildChatModel({
      provider: session.provider,
      model: session.model,
      apiKey: null,
      credentialId: session.credentialId ?? null,
      apiEndpoint: session.apiEndpoint ?? null,
    })
    const res = await llm.invoke([new HumanMessage(prompt)])
    return typeof res.content === 'string' ? res.content : ''
  }

  try {
    const result = await summarizeAndCompact({
      messages,
      keepLastN,
      agentId: session.agentId ?? null,
      sessionId: id,
      provider: session.provider as string,
      model: session.model as string,
      generateSummary,
    })
    replaceAllMessages(id, result.messages)
    return NextResponse.json({
      status: 'compacted',
      prunedCount: result.prunedCount,
      memoriesStored: result.memoriesStored,
      summaryAdded: result.summaryAdded,
      messageCount: result.messages.length,
    })
  } catch (err: unknown) {
    return NextResponse.json(
      { error: `Compaction failed: ${errorMessage(err)}` },
      { status: 500 },
    )
  }
}
