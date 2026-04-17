import { NextResponse } from 'next/server'
import { z } from 'zod'
import { restoreChatFromUndoToken } from '@/lib/server/chats/chat-session-service'
import { badRequest, notFound } from '@/lib/server/collection-helpers'
import { safeParseBody } from '@/lib/server/safe-parse-body'

const BodySchema = z.object({
  undoToken: z.string().min(1),
})

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const parsed = await safeParseBody(req, BodySchema)
  if (parsed.error) return parsed.error
  const token = parsed.data.undoToken.trim()
  if (!token) return badRequest('undoToken is required')
  const result = restoreChatFromUndoToken(id, token)
  if (!result.ok) {
    if (result.status === 404) return notFound(result.payload.error)
    return NextResponse.json(result.payload, { status: result.status })
  }
  return NextResponse.json(result.payload)
}
