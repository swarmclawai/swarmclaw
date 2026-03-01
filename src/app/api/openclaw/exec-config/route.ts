import { NextResponse } from 'next/server'
import { getExecConfig, setExecConfig } from '@/lib/server/openclaw-exec-config'
import type { ExecApprovalConfig } from '@/types'

/** GET ?agentId=X — fetch exec approval config */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const agentId = searchParams.get('agentId')
  if (!agentId) {
    return NextResponse.json({ error: 'Missing agentId' }, { status: 400 })
  }

  try {
    const snapshot = await getExecConfig(agentId)
    return NextResponse.json(snapshot)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 502 })
  }
}

/** PUT { agentId, config, baseHash } — save exec approval config */
export async function PUT(req: Request) {
  const body = await req.json()
  const { agentId, config, baseHash } = body as {
    agentId?: string
    config?: ExecApprovalConfig
    baseHash?: string
  }
  if (!agentId || !config) {
    return NextResponse.json({ error: 'Missing agentId or config' }, { status: 400 })
  }

  try {
    const result = await setExecConfig(agentId, config, baseHash ?? '')
    return NextResponse.json(result)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
