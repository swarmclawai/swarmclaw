import { NextResponse } from 'next/server'
import fs from 'fs'
import { z } from 'zod'

import { APP_LOG_PATH } from '@/lib/server/data-dir'
import { log } from '@/lib/server/logger'
import { safeParseBody } from '@/lib/server/safe-parse-body'

/** Max bytes to read from the tail of the log file (256 KB). */
const TAIL_BYTES = 256 * 1024

const ClientLogSchema = z.object({
  source: z.string().trim().min(1).max(120).optional().default('client'),
  message: z.string().trim().min(1).max(1000),
  stack: z.string().max(8000).optional(),
  componentStack: z.string().max(8000).optional(),
  digest: z.string().max(200).optional(),
  url: z.string().max(2000).optional(),
  pathname: z.string().max(1000).optional(),
  userAgent: z.string().max(1000).optional(),
})

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const lines = parseInt(searchParams.get('lines') || '200', 10)
  const level = searchParams.get('level') || '' // INFO, WARN, ERROR, DEBUG
  const search = searchParams.get('search') || ''

  try {
    if (!fs.existsSync(APP_LOG_PATH)) {
      return NextResponse.json({ entries: [], total: 0 })
    }

    const stat = fs.statSync(APP_LOG_PATH)
    const fileSize = stat.size
    if (fileSize === 0) {
      return NextResponse.json({ entries: [], total: 0 })
    }

    // Read only the tail of the file to avoid loading multi-MB logs into memory
    const readSize = Math.min(fileSize, TAIL_BYTES)
    const buf = Buffer.alloc(readSize)
    const fd = fs.openSync(APP_LOG_PATH, 'r')
    try {
      fs.readSync(fd, buf, 0, readSize, fileSize - readSize)
    } finally {
      fs.closeSync(fd)
    }

    let content = buf.toString('utf8')
    // If we didn't read from the start, drop the first partial line
    if (readSize < fileSize) {
      const firstNewline = content.indexOf('\n')
      if (firstNewline >= 0) content = content.slice(firstNewline + 1)
    }

    let allLines = content.split('\n').filter(Boolean)

    // Filter by level
    if (level) {
      const levels = level.split(',')
      allLines = allLines.filter((l) => levels.some((lv) => l.includes(`[${lv}]`)))
    }

    // Filter by search term
    if (search) {
      const lower = search.toLowerCase()
      allLines = allLines.filter((l) => l.toLowerCase().includes(lower))
    }

    const total = allLines.length
    // Return most recent lines
    const entries = allLines.slice(-lines).reverse().map(parseLine)

    return NextResponse.json({ entries, total })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function DELETE() {
  try {
    if (fs.existsSync(APP_LOG_PATH)) {
      fs.writeFileSync(APP_LOG_PATH, '')
    }
    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const { data: body, error } = await safeParseBody(req, ClientLogSchema)
  if (error) return error

  try {
    log.error(body.source, body.message, {
      stack: body.stack,
      componentStack: body.componentStack,
      digest: body.digest,
      url: body.url,
      pathname: body.pathname,
      userAgent: body.userAgent,
    })
    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

function parseLine(line: string) {
  // Format: [2026-02-19T17:06:00.000Z] [INFO] [tag] message | data
  const match = line.match(/^\[([^\]]+)\]\s+\[(\w+)\]\s+\[([^\]]+)\]\s+(.*)$/)
  if (!match) return { time: '', level: 'INFO', tag: '', message: line }

  const [, time, level, tag, rest] = match
  const pipeIdx = rest.indexOf(' | ')
  const message = pipeIdx >= 0 ? rest.slice(0, pipeIdx) : rest
  const data = pipeIdx >= 0 ? rest.slice(pipeIdx + 3) : undefined

  return { time, level, tag, message, data }
}
