import { NextResponse } from 'next/server'
import { z } from 'zod'
import { notFound } from '@/lib/server/collection-helpers'
import { formatZodError } from '@/lib/validation/schemas'
import { ProtocolTemplateUpsertSchema } from '@/lib/validation/server-schemas'
import {
  deleteProtocolTemplateById,
  loadProtocolTemplateById,
  updateProtocolTemplate,
  type UpsertProtocolTemplateInput,
} from '@/lib/server/protocols/protocol-service'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const template = loadProtocolTemplateById(id)
  if (!template) return notFound()
  return NextResponse.json(template)
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const existing = loadProtocolTemplateById(id)
  if (!existing) return notFound()
  if (existing.builtIn) {
    return NextResponse.json({ error: 'Built-in templates cannot be edited.' }, { status: 409 })
  }
  const raw = await req.json().catch(() => ({}))
  const parsed = ProtocolTemplateUpsertSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(formatZodError(parsed.error as z.ZodError), { status: 400 })
  }
  const updated = updateProtocolTemplate(id, parsed.data as UpsertProtocolTemplateInput)
  if (!updated) {
    return NextResponse.json({ error: 'Unable to update structured-session template.' }, { status: 409 })
  }
  return NextResponse.json(updated)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const existing = loadProtocolTemplateById(id)
  if (!existing) return notFound()
  if (existing.builtIn) {
    return NextResponse.json({ error: 'Built-in templates cannot be deleted.' }, { status: 409 })
  }
  const deleted = deleteProtocolTemplateById(id)
  if (!deleted) {
    return NextResponse.json({ error: 'Unable to delete structured-session template.' }, { status: 409 })
  }
  return NextResponse.json({ ok: true })
}
