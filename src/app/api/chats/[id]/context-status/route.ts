import { NextResponse } from 'next/server'
import { getSession } from '@/lib/server/sessions/session-repository'
import { getMessages } from '@/lib/server/messages/message-repository'
import { getContextStatus } from '@/lib/server/context-manager'
import { notFound } from '@/lib/server/collection-helpers'

const SYSTEM_PROMPT_TOKEN_ESTIMATE = 2000

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = getSession(id)
  if (!session) return notFound()
  const messages = getMessages(id)
  const status = getContextStatus(
    messages,
    SYSTEM_PROMPT_TOKEN_ESTIMATE,
    session.provider as string,
    session.model as string,
  )
  return NextResponse.json(status)
}
