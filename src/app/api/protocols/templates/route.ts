import { NextResponse } from 'next/server'
import { z } from 'zod'
import { formatZodError } from '@/lib/validation/schemas'
import { ProtocolTemplateUpsertSchema } from '@/lib/validation/server-schemas'
import {
  createProtocolTemplate,
  listProtocolTemplates,
  type UpsertProtocolTemplateInput,
} from '@/lib/server/protocols/protocol-service'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(listProtocolTemplates())
}

export async function POST(req: Request) {
  const raw = await req.json().catch(() => ({}))
  const parsed = ProtocolTemplateUpsertSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(formatZodError(parsed.error as z.ZodError), { status: 400 })
  }
  try {
    const template = createProtocolTemplate(parsed.data as UpsertProtocolTemplateInput)
    return NextResponse.json(template)
  } catch (err) {
    return NextResponse.json({
      error: err instanceof Error ? err.message : 'Unable to create structured-session template.',
    }, { status: 400 })
  }
}
