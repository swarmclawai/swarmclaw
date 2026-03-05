import { NextResponse } from 'next/server'
import { enqueueSessionRun, type SessionQueueMode } from '@/lib/server/session-run-manager'
import { log } from '@/lib/server/logger'

function normalizeQueueMode(raw: unknown, internal: boolean): SessionQueueMode {
  if (raw === 'steer' || raw === 'collect' || raw === 'followup') return raw
  return internal ? 'collect' : 'followup'
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json().catch(() => ({}))

  const message = typeof body.message === 'string' ? body.message : ''
  const imagePath = typeof body.imagePath === 'string' ? body.imagePath : undefined
  const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl : undefined
  const attachedFiles = Array.isArray(body.attachedFiles) ? body.attachedFiles.filter((f: unknown) => typeof f === 'string') as string[] : undefined
  const internal = body.internal === true
  const queueMode = normalizeQueueMode(body.queueMode, internal)
  const replyToId = typeof body.replyToId === 'string' ? body.replyToId : undefined

  const hasFiles = !!(imagePath || imageUrl || (attachedFiles && attachedFiles.length > 0))
  if (!message.trim() && !hasFiles) {
    return NextResponse.json({ error: 'message or file is required' }, { status: 400 })
  }

  const encoder = new TextEncoder()
  let abortRun: (() => void) | null = null
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
        source: internal ? 'heartbeat' : 'chat',
        mode: queueMode,
        onEvent: (ev) => writeEvent(ev as unknown as Record<string, unknown>),
        replyToId,
        callerSignal: req.signal,
      })
      abortRun = run.abort

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
      // Client disconnected — abort the run so the LLM stream is cancelled.
      abortRun?.()
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
