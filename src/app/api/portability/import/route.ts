import { NextResponse } from 'next/server'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import { importConfig } from '@/lib/server/portability/import'
import type { PortableManifest } from '@/lib/server/portability/export'
import { PortableManifestSchema, formatZodError } from '@/lib/validation/schemas'
import { z } from 'zod'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const { data: raw, error } = await safeParseBody(req)
  if (error) return error

  const parsed = PortableManifestSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(formatZodError(parsed.error as z.ZodError), { status: 400 })
  }

  try {
    const result = importConfig(parsed.data as PortableManifest)
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to import manifest'
    if (/^Unsupported format version /i.test(message)) {
      return NextResponse.json({ error: message }, { status: 400 })
    }
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
