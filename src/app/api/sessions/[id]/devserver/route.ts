import { NextResponse } from 'next/server'
import { spawn } from 'child_process'
import { loadSessions, devServers, localIP } from '@/lib/server/storage'
import { notFound } from '@/lib/server/collection-helpers'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const sessions = loadSessions()
  const session = sessions[id]
  if (!session) return notFound()

  const { action } = await req.json()

  if (action === 'start') {
    if (devServers.has(id)) {
      const ds = devServers.get(id)!
      return NextResponse.json({ running: true, url: ds.url })
    }

    const proc = spawn('npm', ['run', 'dev', '--', '--host', '0.0.0.0'], {
      cwd: session.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    })

    let output = ''
    let detectedUrl: string | null = null
    const urlRe = /https?:\/\/(?:localhost|0\.0\.0\.0|[\d.]+):(\d+)/

    function onData(chunk: Buffer) {
      output += chunk.toString()
      if (!detectedUrl) {
        const match = output.match(urlRe)
        if (match) {
          const port = match[1]
          detectedUrl = `http://${localIP()}:${port}`
          const ds = devServers.get(id)
          if (ds) ds.url = detectedUrl
        }
      }
    }

    proc.stdout!.on('data', onData)
    proc.stderr!.on('data', onData)
    proc.on('close', () => { devServers.delete(id); console.log(`[${id}] dev server stopped`) })
    proc.on('error', () => devServers.delete(id))

    devServers.set(id, { proc, url: `http://${localIP()}:4321` })
    console.log(`[${id}] starting dev server in ${session.cwd}`)

    // Wait for URL detection
    await new Promise(resolve => setTimeout(resolve, 4000))
    const ds = devServers.get(id)
    return NextResponse.json({ running: !!ds, url: ds?.url || `http://${localIP()}:4321` })

  } else if (action === 'stop') {
    if (devServers.has(id)) {
      const ds = devServers.get(id)!
      try { ds.proc.kill('SIGTERM') } catch {}
      try { process.kill(-ds.proc.pid, 'SIGTERM') } catch {}
      devServers.delete(id)
    }
    return NextResponse.json({ running: false })

  } else if (action === 'status') {
    return NextResponse.json({ running: devServers.has(id), url: devServers.get(id)?.url })
  }

  return NextResponse.json({ running: false })
}
