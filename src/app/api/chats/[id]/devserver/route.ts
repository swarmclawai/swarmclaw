import { NextResponse } from 'next/server'
import { spawn } from 'child_process'
import { loadSessions, devServers, localIP } from '@/lib/server/storage'
import { notFound } from '@/lib/server/collection-helpers'
import { resolveDevServerLaunchDir } from '@/lib/server/runtime/devserver-launch'
import { sleep } from '@/lib/shared-utils'
import net from 'net'

interface DevServerStartResult {
  status?: number
  body: Record<string, unknown>
}

const inflightDevServerStarts = new Map<string, Promise<DevServerStartResult>>()

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '0.0.0.0', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((err) => err ? reject(err) : resolve(port))
    })
    server.on('error', reject)
  })
}

function buildDevArgs(framework: string, port: number): string[] {
  if (framework === 'next') {
    return ['--', '--hostname', '0.0.0.0', '--port', String(port)]
  }
  return ['--', '--host', '0.0.0.0', '--port', String(port)]
}

async function startDevServer(id: string, session: { cwd: string }): Promise<DevServerStartResult> {
  const launch = resolveDevServerLaunchDir(session.cwd)
  const port = await findFreePort()
  const proc = spawn('npm', ['run', 'dev', ...buildDevArgs(launch.framework, port)], {
    cwd: launch.launchDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0', PORT: String(port) },
  })

  let output = ''
  let detectedUrl: string | null = null
  const urlRe = /https?:\/\/(?:localhost|0\.0\.0\.0|[\d.]+):(\d+)/

  function onData(chunk: Buffer) {
    output += chunk.toString()
    if (!detectedUrl) {
      const match = output.match(urlRe)
      if (match) {
        const detectedPort = match[1]
        detectedUrl = `http://${localIP()}:${detectedPort}`
        const ds = devServers.get(id)
        if (ds) ds.url = detectedUrl
      }
    }
  }

  proc.stdout!.on('data', onData)
  proc.stderr!.on('data', onData)
  proc.on('close', () => { devServers.delete(id); console.log(`[${id}] dev server stopped`) })
  proc.on('error', () => devServers.delete(id))

  devServers.set(id, { proc, url: `http://${localIP()}:${port}` })
  console.log(`[${id}] starting dev server in ${launch.launchDir} (session cwd=${session.cwd})`)

  await sleep(4000)
  const ds = devServers.get(id)
  if (!ds) {
    return {
      status: 502,
      body: {
        running: false,
        error: 'Dev server exited during startup',
        cwd: launch.launchDir,
        sessionCwd: session.cwd,
        framework: launch.framework,
        output: output.slice(-4000),
      },
    }
  }

  return {
    body: {
      running: true,
      url: ds.url,
      cwd: launch.launchDir,
      sessionCwd: session.cwd,
      framework: launch.framework,
    },
  }
}

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

    let startPromise = inflightDevServerStarts.get(id)
    if (!startPromise) {
      startPromise = startDevServer(id, session).finally(() => {
        if (inflightDevServerStarts.get(id) === startPromise) {
          inflightDevServerStarts.delete(id)
        }
      })
      inflightDevServerStarts.set(id, startPromise)
    }
    const result = await startPromise
    return NextResponse.json(result.body, result.status ? { status: result.status } : undefined)

  } else if (action === 'stop') {
    if (devServers.has(id)) {
      const ds = devServers.get(id)!
      try { ds.proc.kill('SIGTERM') } catch {}
      if (typeof ds.proc.pid === 'number') {
        try { process.kill(-ds.proc.pid, 'SIGTERM') } catch {}
      }
      devServers.delete(id)
    }
    return NextResponse.json({ running: false })

  } else if (action === 'status') {
    return NextResponse.json({ running: devServers.has(id), url: devServers.get(id)?.url })
  }

  return NextResponse.json({ running: false })
}
