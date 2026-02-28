import fs from 'fs'
import path from 'path'

import { DATA_DIR } from './data-dir'

const LOG_FILE = path.join(DATA_DIR, 'app.log')
const MAX_SIZE = 5 * 1024 * 1024 // 5MB — rotate when exceeded

function rotate() {
  try {
    const stat = fs.statSync(LOG_FILE)
    if (stat.size > MAX_SIZE) {
      const old = LOG_FILE + '.old'
      if (fs.existsSync(old)) fs.unlinkSync(old)
      fs.renameSync(LOG_FILE, old)
    }
  } catch {
    // file doesn't exist yet, fine
  }
}

function write(level: string, tag: string, message: string, data?: unknown) {
  const ts = new Date().toISOString()
  let line = `[${ts}] [${level}] [${tag}] ${message}`
  if (data !== undefined) {
    try {
      const s = typeof data === 'string' ? data : JSON.stringify(data, null, 0)
      line += ' | ' + s.slice(0, 2000)
    } catch {
      line += ' | [unserializable]'
    }
  }
  line += '\n'
  try {
    rotate()
    fs.appendFileSync(LOG_FILE, line)
  } catch (e) {
    console.error('[logger] write failed:', e)
  }
}

export const log = {
  info: (tag: string, msg: string, data?: unknown) => write('INFO', tag, msg, data),
  warn: (tag: string, msg: string, data?: unknown) => write('WARN', tag, msg, data),
  error: (tag: string, msg: string, data?: unknown) => write('ERROR', tag, msg, data),
  debug: (tag: string, msg: string, data?: unknown) => write('DEBUG', tag, msg, data),
}
