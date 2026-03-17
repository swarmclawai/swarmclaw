import { NextResponse } from 'next/server'
import { spawn } from 'child_process'
import { notFound } from '@/lib/server/collection-helpers'
import { resolveDevServerLaunchDir } from '@/lib/server/runtime/devserver-launch'
import { clearDevServer, getDevServer, hasDevServer, registerDevServer, stopDevServer, updateDevServerUrl } from '@/lib/server/runtime/runtime-state'
import { localIP } from '@/lib/server/runtime/network'
import { listSessions } from '@/lib/server/sessions/session-repository'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import { sleep } from '@/lib/shared-utils'
import net from 'net'
import { log } from '@/lib/server/logger'

const TAG = 'api-devserver'

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
        updateDevServerUrl(id, detectedUrl)
      }
    }
  }

  proc.stdout!.on('data', onData)
  proc.stderr!.on('data', onData)
  proc.on('close', () => { clearDevServer(id); log.info(TAG, `dev server stopped for ${id}`) })
  proc.on('error', () => clearDevServer(id))

  registerDevServer(id, { proc, url: `http://${localIP()}:${port}` })
  log.info(TAG, `starting dev server in ${launch.launchDir} (session cwd=${session.cwd})`)

  await sleep(4000)
  const ds = getDevServer(id)
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
  const sessions = listSessions()
  const session = sessions[id]
  if (!session) return notFound()

  const { data: body, error } = await safeParseBody<{ action: string }>(req)
  if (error) return error
  const { action } = body

  if (action === 'start') {
    if (hasDevServer(id)) {
      const ds = getDevServer(id)!
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
    stopDevServer(id)
    return NextResponse.json({ running: false })

  } else if (action === 'status') {
    return NextResponse.json({ running: hasDevServer(id), url: getDevServer(id)?.url })
  }

  return NextResponse.json({ running: false })
}
