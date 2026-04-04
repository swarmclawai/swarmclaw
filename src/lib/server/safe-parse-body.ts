import { NextResponse } from 'next/server'
import { z } from 'zod'

import { formatZodError } from '@/lib/validation/schemas'

type SafeResult<T> = { data: T; error?: never } | { data?: never; error: NextResponse }

/**
 * Wraps `req.json()` so malformed/empty bodies return a 400
 * instead of throwing an unhandled error (500).
 */
export async function safeParseBody<T = Record<string, unknown>>(
  req: Request,
  schema?: z.ZodType<T>,
): Promise<SafeResult<T>> {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return { error: NextResponse.json({ error: 'Invalid or missing request body' }, { status: 400 }) }
  }

  if (!schema) {
    return { data: raw as T }
  }

  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    return { error: NextResponse.json(formatZodError(parsed.error), { status: 400 }) }
  }

  return { data: parsed.data }
}
