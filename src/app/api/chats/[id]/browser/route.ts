import { NextResponse } from 'next/server'
import { hasActiveBrowser, cleanupSessionBrowser } from '@/lib/server/session-tools'
import { loadBrowserSessionRecord } from '@/lib/server/browser-state'
import { getBrowserBridgeForScope } from '@/lib/server/sandbox/browser-bridge'
import { buildNoVncObserverTokenUrl, issueNoVncObserverToken } from '@/lib/server/sandbox/novnc-auth'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const state = loadBrowserSessionRecord(id)
  const scopeKey = typeof state?.sandbox?.scopeKey === 'string' ? state.sandbox.scopeKey : ''
  const bridge = scopeKey ? getBrowserBridgeForScope(scopeKey) : null
  const observerUrl = bridge?.noVncPort
    ? buildNoVncObserverTokenUrl(
        bridge.bridge.baseUrl,
        issueNoVncObserverToken({
          noVncPort: bridge.noVncPort,
          password: bridge.noVncPassword || undefined,
        }),
      )
    : null
  return NextResponse.json({
    active: hasActiveBrowser(id),
    observerUrl,
    state,
  })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  cleanupSessionBrowser(id)
  return new NextResponse('OK')
}
