#!/usr/bin/env node
/**
 * MCP proxy for Playwright that intercepts browser_screenshot responses,
 * saves images to the uploads directory, and tells Claude the image URL
 * so it can reference it in its response.
 */
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'

const UPLOAD_DIR = process.env.SWARMCLAW_UPLOAD_DIR || path.join(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'uploads')
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })

function resolvePlaywrightCli() {
  const candidates = [
    path.join(process.cwd(), 'node_modules', '@playwright', 'mcp', 'cli.js'),
    path.join(process.cwd(), '[project]', 'node_modules', '@playwright', 'mcp', 'cli.js'),
  ]
  return candidates.find((candidate) => fs.existsSync(candidate)) || null
}

function sanitizePlaywrightEnv(baseEnv) {
  const env = { ...baseEnv }
  for (const key of Object.keys(env)) {
    if (!key.toUpperCase().startsWith('PLAYWRIGHT_MCP_')) continue
    delete env[key]
  }
  return env
}

const cliPath = resolvePlaywrightCli()
const child = cliPath
  ? spawn(process.execPath, [cliPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: sanitizePlaywrightEnv(process.env),
    })
  : spawn('npx', ['@playwright/mcp@latest'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: sanitizePlaywrightEnv(process.env),
    })

// Graceful EPIPE handling — dev server restarts break stdio pipes
function safeWrite(stream, chunk) {
  try { stream.write(chunk) } catch { /* EPIPE during restart, ignore */ }
}

process.stdin.on('data', (chunk) => safeWrite(child.stdin, chunk))
process.stdin.on('end', () => { try { child.stdin.end() } catch { /* ignore */ } })
child.stdin.on('error', (err) => {
  if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') return
  process.stderr.write(`Proxy child stdin error: ${err.message}\n`)
})

// Parse MCP Content-Length framed messages from child stdout, intercept screenshots
let buf = ''
child.stdout.on('data', (chunk) => {
  buf += chunk.toString()
  while (true) {
    const headerEnd = buf.indexOf('\r\n\r\n')
    if (headerEnd === -1) break
    const header = buf.slice(0, headerEnd)
    const match = header.match(/Content-Length:\s*(\d+)/i)
    if (!match) { buf = buf.slice(headerEnd + 4); continue }
    const contentLength = parseInt(match[1])
    const bodyStart = headerEnd + 4
    if (buf.length < bodyStart + contentLength) break
    const body = buf.slice(bodyStart, bodyStart + contentLength)
    buf = buf.slice(bodyStart + contentLength)

    let output
    try {
      const msg = JSON.parse(body)
      if (msg.result?.content && Array.isArray(msg.result.content)) {
        const newContent = []
        for (const block of msg.result.content) {
          if (block.type === 'image' && block.data) {
            const filename = `screenshot-${Date.now()}.png`
            fs.writeFileSync(path.join(UPLOAD_DIR, filename), Buffer.from(block.data, 'base64'))
            newContent.push({
              type: 'text',
              text: `Screenshot saved to /api/uploads/${filename} — it is already displayed inline above (do not repeat it with markdown).`,
            })
            newContent.push(block) // keep image so Claude can see it
          } else {
            newContent.push(block)
          }
        }
        msg.result.content = newContent
      }
      output = JSON.stringify(msg)
    } catch {
      output = body
    }
    const frame = `Content-Length: ${Buffer.byteLength(output)}\r\n\r\n${output}`
    safeWrite(process.stdout, frame)
  }
})
child.stdout.on('error', (err) => {
  if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') return
  process.stderr.write(`Proxy child stdout error: ${err.message}\n`)
})

child.stderr.on('data', (chunk) => safeWrite(process.stderr, chunk))
child.stderr.on('error', () => { /* ignore stderr errors */ })
child.on('close', (code) => process.exit(code || 0))
child.on('error', (err) => { safeWrite(process.stderr, `Proxy error: ${err.message}\n`); process.exit(1) })

// Handle parent stdout/stderr EPIPE (broken pipe when dev server restarts)
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') { child.kill(); process.exit(0) }
})
process.stderr.on('error', () => { /* ignore */ })
