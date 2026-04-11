import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

import { DATA_DIR, IS_BUILD_BOOTSTRAP } from './data-dir'
import { log } from '@/lib/server/logger'

const TAG = 'storage-auth'

// Fallback env file inside the data directory — survives Docker container restarts
// because DATA_DIR is volume-mounted, unlike process.cwd()/.env.local.
const GENERATED_ENV_PATH = path.join(DATA_DIR, '.env.generated')

// --- .env loading ---
function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return
  fs.readFileSync(filePath, 'utf8').split(/\r?\n/).forEach(line => {
    const [k, ...v] = line.split('=')
    if (k && v.length) process.env[k.trim()] = v.join('=').trim()
  })
}

function loadEnv() {
  // Load fallback first so that .env.local values take precedence.
  // .env.generated is auto-created in Docker where .env.local isn't writable.
  loadEnvFile(GENERATED_ENV_PATH)
  loadEnvFile(path.join(process.cwd(), '.env.local'))
}
if (!IS_BUILD_BOOTSTRAP) {
  loadEnv()
}

/** Append a key=value to a file only if the key doesn't already exist in it. */
function appendEnvKeyIfMissing(envPath: string, key: string, value: string): void {
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''
  const keyPattern = new RegExp(`^${key}=`, 'm')
  if (keyPattern.test(existing)) return
  fs.appendFileSync(envPath, `\n${key}=${value}\n`)
}

/** Try to persist a key to .env.local, falling back to DATA_DIR/.env.generated. */
function persistEnvKey(key: string, value: string): void {
  const envLocalPath = path.join(process.cwd(), '.env.local')
  // Try .env.local first (works for local dev, npm run dev)
  try {
    appendEnvKeyIfMissing(envLocalPath, key, value)
    return
  } catch {
    // .env.local not writable — expected in Docker containers
  }
  // Fall back to the data directory (volume-mounted in Docker)
  try {
    fs.mkdirSync(path.dirname(GENERATED_ENV_PATH), { recursive: true })
    appendEnvKeyIfMissing(GENERATED_ENV_PATH, key, value)
  } catch (err) {
    log.warn(TAG, `Could not persist ${key} to disk. It will be regenerated on restart.`, {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

// Auto-generate CREDENTIAL_SECRET if missing
if (!IS_BUILD_BOOTSTRAP && !process.env.CREDENTIAL_SECRET) {
  const secret = crypto.randomBytes(32).toString('hex')
  process.env.CREDENTIAL_SECRET = secret
  persistEnvKey('CREDENTIAL_SECRET', secret)
  log.info(TAG, 'Generated CREDENTIAL_SECRET')
}

// Auto-generate ACCESS_KEY if missing (used for simple auth)
const SETUP_FLAG = path.join(DATA_DIR, '.setup_pending')
if (!IS_BUILD_BOOTSTRAP && !process.env.ACCESS_KEY) {
  const key = crypto.randomBytes(16).toString('hex')
  process.env.ACCESS_KEY = key
  persistEnvKey('ACCESS_KEY', key)
  try { fs.writeFileSync(SETUP_FLAG, key) } catch { /* non-fatal */ }
  log.info(TAG, `ACCESS KEY: ${key} — Use this key to connect from the browser.`)
}

export function getAccessKey(): string {
  return process.env.ACCESS_KEY || ''
}

export function validateAccessKey(key: string): boolean {
  return key === process.env.ACCESS_KEY
}

export function isFirstTimeSetup(): boolean {
  return fs.existsSync(SETUP_FLAG)
}

export function markSetupComplete(): void {
  if (fs.existsSync(SETUP_FLAG)) fs.unlinkSync(SETUP_FLAG)
}

/** Replace the access key in memory and on disk (first-time setup override). */
export function replaceAccessKey(newKey: string): void {
  // Update in both possible locations
  for (const envPath of [path.join(process.cwd(), '.env.local'), GENERATED_ENV_PATH]) {
    try {
      if (fs.existsSync(envPath)) {
        const contents = fs.readFileSync(envPath, 'utf-8')
        if (/^ACCESS_KEY=/m.test(contents)) {
          fs.writeFileSync(envPath, contents.replace(/^ACCESS_KEY=.*$/m, `ACCESS_KEY=${newKey}`))
          continue
        }
      }
      appendEnvKeyIfMissing(envPath, 'ACCESS_KEY', newKey)
    } catch {
      // Not writable — try the other location
    }
  }
  process.env.ACCESS_KEY = newKey
}
