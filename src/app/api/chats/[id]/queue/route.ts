import { NextResponse } from 'next/server'
import { notFound } from '@/lib/server/collection-helpers'
import { loadSession } from '@/lib/server/storage'
import {
  cancelQueuedRunById,
  cancelQueuedRunsForSession,
  enqueueSessionRun,
  getSessionQueueSnapshot,
} from '@/lib/server/runtime/session-run-manager'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = loadSession(id)
  if (!session) return notFound()
  return NextResponse.json(getSessionQueueSnapshot(id))
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = loadSession(id)
  if (!session) return notFound()

  const body = await req.json().catch(() => ({}))
  const message = typeof body.message === 'string' ? body.message : ''
  const imagePath = typeof body.imagePath === 'string' ? body.imagePath : undefined
  const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl : undefined
  const attachedFiles = Array.isArray(body.attachedFiles)
    ? body.attachedFiles.filter((file: unknown): file is string => typeof file === 'string' && file.trim().length > 0)
    : undefined
  const replyToId = typeof body.replyToId === 'string' ? body.replyToId : undefined
  const hasFiles = !!(imagePath || imageUrl || attachedFiles?.length)

  if (!message.trim() && !hasFiles) {
    return NextResponse.json({ error: 'message or file is required' }, { status: 400 })
  }

  const queued = enqueueSessionRun({
    sessionId: id,
    message,
    imagePath,
    imageUrl,
    attachedFiles,
    source: 'chat',
    mode: 'followup',
    replyToId,
  })

  return NextResponse.json({
    queued: {
      runId: queued.runId,
      position: queued.position,
    },
    snapshot: getSessionQueueSnapshot(id),
  }, { status: 202 })
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = loadSession(id)
  if (!session) return notFound()

  const body = await req.json().catch(() => ({}))
  const runId = typeof body.runId === 'string' ? body.runId.trim() : ''
  if (runId) {
    const snapshot = getSessionQueueSnapshot(id)
    if (!snapshot.items.some((item) => item.runId === runId)) {
      return NextResponse.json({ error: 'Queued run not found' }, { status: 404 })
    }
    cancelQueuedRunById(runId, 'Removed from queue')
    return NextResponse.json({
      cancelled: 1,
      snapshot: getSessionQueueSnapshot(id),
    })
  }

  const cancelled = cancelQueuedRunsForSession(id, 'Cleared queued messages')
  return NextResponse.json({
    cancelled,
    snapshot: getSessionQueueSnapshot(id),
  })
}
