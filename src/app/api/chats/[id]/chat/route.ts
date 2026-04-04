import { NextResponse } from 'next/server'
import { z } from 'zod'

import { enqueueSessionRun, type SessionQueueMode } from '@/lib/server/runtime/session-run-manager'
import { log } from '@/lib/server/logger'
import { safeParseBody } from '@/lib/server/safe-parse-body'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const ChatRouteBodySchema = z.object({
  message: z.string().optional().default(''),
  imagePath: z.string().optional(),
  imageUrl: z.string().optional(),
  attachedFiles: z.array(z.string()).optional(),
  internal: z.boolean().optional().default(false),
  queueMode: z.enum(['steer', 'collect', 'followup']).optional(),
  replyToId: z.string().optional(),
}).passthrough()

function normalizeQueueMode(raw: unknown, internal: boolean): SessionQueueMode {
  if (raw === 'steer' || raw === 'collect' || raw === 'followup') return raw
  return internal ? 'collect' : 'followup'
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const { data: body, error } = await safeParseBody(req, ChatRouteBodySchema)
    if (error) return error

    const message = body.message
    const imagePath = body.imagePath
    const imageUrl = body.imageUrl
    const attachedFiles = body.attachedFiles
    const internal = body.internal
    const queueMode = normalizeQueueMode(body.queueMode, internal)
    const replyToId = body.replyToId
    const source = internal ? 'heartbeat' : 'chat'

    const hasFiles = !!(imagePath || imageUrl || (attachedFiles && attachedFiles.length > 0))
    if (!message.trim() && !hasFiles) {
      return NextResponse.json({ error: 'message or file is required' }, { status: 400 })
    }

    const encoder = new TextEncoder()
    let abortRun: (() => void) | null = null
    let unsubscribeRun: (() => void) | null = null
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

        const run = enqueueSessionRun({
          sessionId: id,
          message,
          imagePath,
          imageUrl,
          attachedFiles,
          internal,
          source,
          mode: queueMode,
          onEvent: (ev) => writeEvent(ev as unknown as Record<string, unknown>),
          replyToId,
          // Keep user-initiated runs alive even if the SSE transport drops so
          // long-lived tasks can finish and be observed later via polling/history.
          callerSignal: internal ? req.signal : undefined,
        })
        abortRun = run.abort
        unsubscribeRun = run.unsubscribe

        log.info('chat', `Enqueued session run ${run.runId}`, {
          sessionId: id,
          internal,
          mode: queueMode,
          position: run.position,
          deduped: run.deduped || false,
          coalesced: run.coalesced || false,
        })

        writeEvent({
          t: 'md',
          text: JSON.stringify({
            run: {
              id: run.runId,
              status: run.deduped ? 'deduped' : run.coalesced ? 'coalesced' : 'queued',
              position: run.position,
              internal,
              source,
              mode: queueMode,
            },
          }),
        })

        run.promise
          .catch((err) => {
            const msg = err?.message || String(err)
            writeEvent({ t: 'err', text: msg })
          })
          .finally(() => {
            writeEvent({ t: 'done' })
            if (!closed) {
              try { controller.close() } catch { /* stream already closed */ }
              closed = true
            }
          })
      },
      cancel() {
        // Client disconnected — always remove this subscriber's listener to
        // prevent writes to a closed stream (and free the closure).
        unsubscribeRun?.()
        // User-facing runs continue in the background so they can persist
        // results even when the transport drops. Internal runs are aborted.
        if (internal) abortRun?.()
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
  } catch (error) {
    log.error('chat-route', 'POST /api/chats/[id]/chat failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    })
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
