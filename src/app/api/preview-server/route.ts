import { NextResponse } from 'next/server'
import { spawn, type ChildProcess } from 'child_process'
import http from 'http'
import fs from 'fs'
import path from 'path'
import { localIP } from '@/lib/server/storage'

// ---------------------------------------------------------------------------
// MIME types for static server
// ---------------------------------------------------------------------------

const MIME_MAP: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css',
  '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.txt': 'text/plain', '.md': 'text/plain',
}

// ---------------------------------------------------------------------------
// Server tracking
// ---------------------------------------------------------------------------

interface PreviewServer {
  type: 'static' | 'npm'
  server?: http.Server   // static server
  proc?: ChildProcess    // npm process
  port: number
  dir: string
  startedAt: number
  log: string
}

const globalKey = '__swarmclaw_preview_servers__' as const
const servers: Map<string, PreviewServer> = (globalThis as unknown as Record<string, unknown>)[globalKey] as Map<string, PreviewServer>
  ?? ((globalThis as unknown as Record<string, unknown>)[globalKey] = new Map<string, PreviewServer>())

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveServeDir(filePath: string): string {
  const resolved = path.resolve(filePath)
  try {
    return fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved)
  } catch {
    return path.dirname(resolved)
  }
}

function dirKey(dir: string): string {
  return dir.replace(/\//g, '_')
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer()
    srv.listen(0, () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// Project type detection
// ---------------------------------------------------------------------------

interface ProjectInfo {
  type: 'npm' | 'static'
  devCommand?: string[]   // e.g. ['npm', 'run', 'dev']
  framework?: string      // e.g. 'vite', 'next', 'cra'
}

function detectProject(dir: string): ProjectInfo {
  const pkgPath = path.join(dir, 'package.json')
  if (!fs.existsSync(pkgPath)) {
    return { type: 'static' }
  }

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
    const scripts = pkg.scripts || {}
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }

    // Detect framework
    let framework = 'node'
    if (deps.next) framework = 'next'
    else if (deps.vite || deps['@vitejs/plugin-react']) framework = 'vite'
    else if (deps['react-scripts']) framework = 'cra'
    else if (deps.astro) framework = 'astro'
    else if (deps.nuxt) framework = 'nuxt'
    else if (deps.svelte || deps['@sveltejs/kit']) framework = 'svelte'
    else if (deps.vue) framework = 'vue'
    else if (deps.angular || deps['@angular/core']) framework = 'angular'

    // Pick the best dev command
    if (scripts.dev) {
      return { type: 'npm', devCommand: ['npm', 'run', 'dev'], framework }
    }
    if (scripts.start) {
      return { type: 'npm', devCommand: ['npm', 'start'], framework }
    }
    if (scripts.serve) {
      return { type: 'npm', devCommand: ['npm', 'run', 'serve'], framework }
    }

    return { type: 'static', framework }
  } catch {
    return { type: 'static' }
  }
}

// ---------------------------------------------------------------------------
// Static file server
// ---------------------------------------------------------------------------

function createStaticServer(dir: string): http.Server {
  return http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')

    let reqPath = decodeURIComponent((req.url || '/').split('?')[0])
    if (reqPath === '/') reqPath = '/index.html'

    const filePath = path.join(dir, reqPath)
    const normalizedFile = path.resolve(filePath)

    if (!normalizedFile.startsWith(dir)) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }

    const candidates = [
      normalizedFile,
      normalizedFile + '.html',
      path.join(normalizedFile, 'index.html'),
    ]

    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        const ext = path.extname(candidate).toLowerCase()
        res.writeHead(200, { 'Content-Type': MIME_MAP[ext] || 'application/octet-stream' })
        fs.createReadStream(candidate).pipe(res)
        return
      }
    }

    if (fs.existsSync(normalizedFile) && fs.statSync(normalizedFile).isDirectory()) {
      const files = fs.readdirSync(normalizedFile)
      const links = files.map((f) => `<li><a href="${reqPath.replace(/\/$/, '')}/${f}">${f}</a></li>`).join('\n')
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(`<!DOCTYPE html><html><head><title>Index of ${reqPath}</title><style>body{font-family:monospace;padding:20px;background:#1a1a2e;color:#e0e0e0}a{color:#60a5fa}</style></head><body><h2>Index of ${reqPath}</h2><ul>${links}</ul></body></html>`)
      return
    }

    res.writeHead(404)
    res.end('Not found')
  })
}

// ---------------------------------------------------------------------------
// npm dev server
// ---------------------------------------------------------------------------

async function startNpmServer(dir: string, command: string[], port: number): Promise<PreviewServer> {
  // Install deps if node_modules missing
  if (!fs.existsSync(path.join(dir, 'node_modules'))) {
    console.log(`[preview] Installing dependencies in ${dir}`)
    await new Promise<void>((resolve, reject) => {
      const install = spawn('npm', ['install'], { cwd: dir, stdio: 'pipe' })
      install.on('close', (code) => code === 0 ? resolve() : reject(new Error(`npm install exited ${code}`)))
      install.on('error', reject)
    })
  }

  const env = {
    ...process.env,
    PORT: String(port),
    FORCE_COLOR: '0',
    BROWSER: 'none',  // CRA: don't open browser
  }

  // Add --port flag for common frameworks
  const args = [...command.slice(1)]
  const cmdName = command[0]

  const proc = spawn(cmdName, [...args, '--', '--port', String(port), '--host', '0.0.0.0'], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  })

  let log = ''
  let detectedPort = port
  const urlRe = /https?:\/\/(?:localhost|0\.0\.0\.0|127\.0\.0\.1|[\d.]+):(\d+)/

  const onData = (chunk: Buffer) => {
    const text = chunk.toString()
    log += text
    if (log.length > 10000) log = log.slice(-5000)
    const match = text.match(urlRe)
    if (match) {
      detectedPort = parseInt(match[1], 10)
      const entry = servers.get(dirKey(dir))
      if (entry) entry.port = detectedPort
    }
  }

  proc.stdout?.on('data', onData)
  proc.stderr?.on('data', onData)

  const entry: PreviewServer = {
    type: 'npm',
    proc,
    port,
    dir,
    startedAt: Date.now(),
    log: '',
  }

  proc.on('close', () => {
    servers.delete(dirKey(dir))
    console.log(`[preview] npm server stopped for ${dir}`)
  })
  proc.on('error', () => servers.delete(dirKey(dir)))

  servers.set(dirKey(dir), entry)

  // Wait for the server to start and detect the actual port
  await new Promise((resolve) => setTimeout(resolve, 5000))
  entry.port = detectedPort
  entry.log = log

  return entry
}

// ---------------------------------------------------------------------------
// API handler
// ---------------------------------------------------------------------------

function buildResponse(srv: PreviewServer) {
  return {
    running: true,
    type: srv.type,
    port: srv.port,
    url: `http://localhost:${srv.port}`,
    networkUrl: `http://${localIP()}:${srv.port}`,
    dir: srv.dir,
  }
}

export async function POST(req: Request) {
  const { action, path: filePath } = await req.json()

  if (!filePath || typeof filePath !== 'string') {
    return NextResponse.json({ error: 'Missing path' }, { status: 400 })
  }

  const dir = resolveServeDir(filePath)
  const key = dirKey(dir)

  if (action === 'start') {
    if (servers.has(key)) {
      return NextResponse.json(buildResponse(servers.get(key)!))
    }

    if (!fs.existsSync(dir)) {
      return NextResponse.json({ error: 'Directory not found' }, { status: 404 })
    }

    const project = detectProject(dir)
    const port = await findFreePort()

    if (project.type === 'npm' && project.devCommand) {
      console.log(`[preview] Detected ${project.framework} project in ${dir}, running: ${project.devCommand.join(' ')}`)
      try {
        const entry = await startNpmServer(dir, project.devCommand, port)
        return NextResponse.json({
          ...buildResponse(entry),
          framework: project.framework,
        })
      } catch (err: unknown) {
        console.error(`[preview] npm server failed, falling back to static:`, err)
        // Fall through to static server
      }
    }

    // Static file server
    const server = createStaticServer(dir)
    await new Promise<void>((resolve, reject) => {
      server.listen(port, '0.0.0.0', () => resolve())
      server.on('error', reject)
    })

    const entry: PreviewServer = { type: 'static', server, port, dir, startedAt: Date.now(), log: '' }
    servers.set(key, entry)
    console.log(`[preview] Started static server for ${dir} on port ${port}`)

    return NextResponse.json(buildResponse(entry))

  } else if (action === 'stop') {
    if (servers.has(key)) {
      const srv = servers.get(key)!
      if (srv.type === 'npm' && srv.proc) {
        try { srv.proc.kill('SIGTERM') } catch {}
        try { if (srv.proc.pid) process.kill(-srv.proc.pid, 'SIGTERM') } catch {}
      }
      if (srv.server) srv.server.close()
      servers.delete(key)
      console.log(`[preview] Stopped server for ${dir}`)
    }
    return NextResponse.json({ running: false, dir })

  } else if (action === 'status') {
    if (servers.has(key)) {
      return NextResponse.json(buildResponse(servers.get(key)!))
    }
    return NextResponse.json({ running: false, dir })

  } else if (action === 'list') {
    const list = Array.from(servers.values()).map((s) => ({
      ...buildResponse(s),
      startedAt: s.startedAt,
    }))
    return NextResponse.json({ servers: list })

  } else if (action === 'detect') {
    const project = detectProject(dir)
    return NextResponse.json({ dir, ...project })
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
}
