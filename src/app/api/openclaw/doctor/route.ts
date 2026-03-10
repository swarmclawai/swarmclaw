import { NextResponse } from 'next/server'
import { runOpenClawDoctor } from '@/lib/server/openclaw/doctor'

export const dynamic = 'force-dynamic'

export async function GET() {
  const result = await runOpenClawDoctor()
  return NextResponse.json(result)
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const fix = typeof body.fix === 'boolean' ? body.fix : false
  const workspace = typeof body.workspace === 'string' ? body.workspace : undefined
  const result = await runOpenClawDoctor({ fix, workspace })
  return NextResponse.json(result)
}
