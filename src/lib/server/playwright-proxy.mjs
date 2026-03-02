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

const child = spawn('npx', ['@playwright/mcp@latest'], {
  stdio: ['pipe', 'pipe', 'pipe'],
})

// Forward stdin → child
process.stdin.on('data', (chunk) => child.stdin.write(chunk))
process.stdin.on('end', () => child.stdin.end())

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
    process.stdout.write(frame)
  }
})

child.stderr.on('data', (chunk) => process.stderr.write(chunk))
child.on('close', (code) => process.exit(code || 0))
child.on('error', (err) => { process.stderr.write(`Proxy error: ${err.message}\n`); process.exit(1) })
