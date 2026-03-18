import { NextResponse } from 'next/server'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import { bulkPatchAgents } from '@/lib/server/agents/agent-service'

export async function PATCH(req: Request) {
  const { data: body, error } = await safeParseBody<Record<string, unknown>>(req)
  if (error) return error
  const result = bulkPatchAgents(body.patches)
  if (result.updated === 0 && result.errors.length === 1 && result.errors[0] === 'patches must be a non-empty array') {
    return NextResponse.json({ error: result.errors[0] }, { status: 400 })
  }
  return NextResponse.json(result)
}
