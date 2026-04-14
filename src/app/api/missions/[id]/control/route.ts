import { NextResponse } from 'next/server'
import { z } from 'zod'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import { formatZodError } from '@/lib/validation/schemas'
import { notFound } from '@/lib/server/collection-helpers'
import { getMission } from '@/lib/server/missions/mission-repository'
import {
  cancelMission,
  completeMission,
  failMission,
  pauseMission,
  startMission,
} from '@/lib/server/missions/mission-service'

export const dynamic = 'force-dynamic'

const ControlSchema = z.object({
  action: z.enum(['start', 'pause', 'resume', 'cancel', 'complete', 'fail']),
  reason: z.string().max(1000).optional(),
}).strict()

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const mission = getMission(id)
  if (!mission) return notFound()
  const { data: body, error } = await safeParseBody<Record<string, unknown>>(req)
  if (error) return error
  const parsed = ControlSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json(formatZodError(parsed.error), { status: 400 })

  switch (parsed.data.action) {
    case 'start':
    case 'resume': {
      const updated = startMission(id)
      return NextResponse.json(updated)
    }
    case 'pause': {
      const updated = pauseMission(id, parsed.data.reason)
      return NextResponse.json(updated)
    }
    case 'cancel': {
      const updated = cancelMission(id, parsed.data.reason)
      return NextResponse.json(updated)
    }
    case 'complete': {
      const updated = completeMission(id, parsed.data.reason)
      return NextResponse.json(updated)
    }
    case 'fail': {
      if (!parsed.data.reason) {
        return NextResponse.json({ error: 'reason is required for fail action' }, { status: 400 })
      }
      const updated = failMission(id, parsed.data.reason)
      return NextResponse.json(updated)
    }
  }
}
