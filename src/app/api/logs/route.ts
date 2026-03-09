import { NextResponse } from 'next/server'
import fs from 'fs'
import { APP_LOG_PATH } from '@/lib/server/data-dir'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const lines = parseInt(searchParams.get('lines') || '200', 10)
  const level = searchParams.get('level') || '' // INFO, WARN, ERROR, DEBUG
  const search = searchParams.get('search') || ''

  try {
    if (!fs.existsSync(APP_LOG_PATH)) {
      return NextResponse.json({ entries: [], total: 0 })
    }

    const content = fs.readFileSync(APP_LOG_PATH, 'utf8')
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
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

export async function DELETE() {
  try {
    if (fs.existsSync(APP_LOG_PATH)) {
      fs.writeFileSync(APP_LOG_PATH, '')
    }
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
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
