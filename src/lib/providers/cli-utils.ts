/**
 * Shared CLI utility module for CLI-based providers and delegation backends.
 *
 * Consolidates environment building, binary discovery, auth probing,
 * abort handling, and config forwarding used by claude-cli, codex-cli,
 * opencode-cli, and gemini-cli providers.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync, type ChildProcess } from 'child_process'
import { log } from '../server/logger'

// ---------------------------------------------------------------------------
// Binary Discovery
// ---------------------------------------------------------------------------

/** Common fallback paths per binary name. */
const KNOWN_BINARY_PATHS: Record<string, string[]> = {
  claude: [
    path.join(os.homedir(), '.local/bin/claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ],
  codex: [
    path.join(os.homedir(), '.local/bin/codex'),
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
    path.join(os.homedir(), '.npm-global/bin/codex'),
  ],
  opencode: [
    path.join(os.homedir(), '.local/bin/opencode'),
    '/usr/local/bin/opencode',
    '/opt/homebrew/bin/opencode',
  ],
  gemini: [
    path.join(os.homedir(), '.local/bin/gemini'),
    '/usr/local/bin/gemini',
    '/opt/homebrew/bin/gemini',
  ],
  copilot: [
    path.join(os.homedir(), '.local/bin/copilot'),
    '/usr/local/bin/copilot',
    '/opt/homebrew/bin/copilot',
    path.join(os.homedir(), '.npm-global/bin/copilot'),
  ],
}

function getNvmBinaryPaths(name: string): string[] {
  const nvmDir = process.env.NVM_DIR || path.join(os.homedir(), '.nvm')
  try {
    const versions = fs.readdirSync(path.join(nvmDir, 'versions/node'))
    return versions.map((v) => path.join(nvmDir, 'versions/node', v, 'bin', name))
  } catch {
    return []
  }
}

/**
 * Resolve a CLI binary path at execution time (not module load time).
 * Uses login-shell `command -v` via findBinaryOnPath (30s TTL cache),
 * then falls back to known paths + nvm paths.
 */
export function resolveCliBinary(name: string, extraPaths?: string[]): string | null {
  // Lazy import to avoid circular dependency at module load
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { findBinaryOnPath } = require('../server/session-tools/context')
  const fromPath = findBinaryOnPath(name) as string | null
  if (fromPath) return fromPath

  const paths = [
    ...(KNOWN_BINARY_PATHS[name] || []),
    ...(extraPaths || []),
    ...getNvmBinaryPaths(name),
  ]
  for (const loc of paths) {
    if (fs.existsSync(loc)) {
      log.info('cli-utils', `Found ${name} at: ${loc}`)
      return loc
    }
  }

  log.warn('cli-utils', `${name} binary not found`)
  return null
}

// ---------------------------------------------------------------------------
// Environment Building
// ---------------------------------------------------------------------------

/** Env var prefixes set by SwarmClaw internally that should not leak to child CLI processes. */
const INTERNAL_ENV_PREFIXES = ['SWARMCLAW_']

/**
 * Build a clean environment for spawning CLI processes.
 * Strips only SwarmClaw-internal env vars, preserving user config.
 */
export function buildCliEnv(opts?: {
  /** Extra key-value pairs to inject into the environment. */
  inject?: Record<string, string>
  /** Additional prefixes to strip beyond the defaults. */
  stripPrefixes?: string[]
}): NodeJS.ProcessEnv {
  const env = { ...process.env, TERM: 'dumb', NO_COLOR: '1' } as NodeJS.ProcessEnv
  const prefixes = [...INTERNAL_ENV_PREFIXES, ...(opts?.stripPrefixes || [])]

  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase()
    if (prefixes.some((p) => upper.startsWith(p))) {
      delete (env as Record<string, unknown>)[key]
    }
  }

  delete (env as Record<string, unknown>).MallocStackLogging

  if (opts?.inject) {
    for (const [key, value] of Object.entries(opts.inject)) {
      env[key] = value
    }
  }

  return env
}

// ---------------------------------------------------------------------------
// Stderr Noise Filter
// ---------------------------------------------------------------------------

const STDERR_NOISE_PATTERNS: RegExp[] = [
  /MallocStackLogging/,
  /^\s*$/,
]

export function isStderrNoise(text: string): boolean {
  return STDERR_NOISE_PATTERNS.some((re) => re.test(text))
}

// ---------------------------------------------------------------------------
// Auth Probing
// ---------------------------------------------------------------------------

export interface AuthProbeResult {
  authenticated: boolean
  errorMessage?: string
}

/**
 * Unified auth check for all 4 CLI tools.
 */
export function probeCliAuth(
  binary: string,
  backend: 'claude' | 'codex' | 'opencode' | 'gemini' | 'copilot',
  env: NodeJS.ProcessEnv,
  cwd?: string,
): AuthProbeResult {
  if (backend === 'claude') {
    const probe = spawnSync(binary, ['auth', 'status'], {
      cwd, env, encoding: 'utf-8', timeout: 8000,
    })
    if ((probe.status ?? 1) !== 0) {
      let loggedIn = false
      try {
        const parsed = JSON.parse(probe.stdout || '{}') as { loggedIn?: boolean }
        loggedIn = parsed.loggedIn === true
      } catch { /* ignore parse issues */ }
      if (!loggedIn) {
        return {
          authenticated: false,
          errorMessage: 'Claude CLI is not authenticated. Run `claude auth login` (or `claude setup-token`) and try again.',
        }
      }
    }
    return { authenticated: true }
  }

  if (backend === 'codex') {
    const probe = spawnSync(binary, ['login', 'status'], {
      cwd, env, encoding: 'utf-8', timeout: 8000,
    })
    const probeText = `${probe.stdout || ''}\n${probe.stderr || ''}`.toLowerCase()
    const loggedIn = probeText.includes('logged in')
    if ((probe.status ?? 1) !== 0 || !loggedIn) {
      return {
        authenticated: false,
        errorMessage: 'Codex CLI is not authenticated. Run `codex login` (or set an API key in provider settings) and try again.',
      }
    }
    return { authenticated: true }
  }

  if (backend === 'opencode') {
    // OpenCode has no known auth subcommand — check for config file existence
    const configPaths = [
      path.join(os.homedir(), '.config/opencode/config.json'),
      path.join(os.homedir(), '.opencode/config.json'),
    ]
    const hasConfig = configPaths.some((p) => fs.existsSync(p))
    if (!hasConfig) {
      // Not fatal — OpenCode may work without config if env vars are set
      log.info('cli-utils', 'No OpenCode config file found, proceeding anyway')
    }
    return { authenticated: true }
  }

  if (backend === 'gemini') {
    // Try `gemini auth status` first, fall back to config file check
    try {
      const probe = spawnSync(binary, ['auth', 'status'], {
        cwd, env, encoding: 'utf-8', timeout: 8000,
      })
      const probeText = `${probe.stdout || ''}\n${probe.stderr || ''}`.toLowerCase()
      if ((probe.status ?? 1) === 0 || probeText.includes('logged in') || probeText.includes('authenticated')) {
        return { authenticated: true }
      }
    } catch { /* auth subcommand may not exist */ }

    // Fall back to config file check / env vars
    const configPaths = [
      path.join(os.homedir(), '.config/gemini/config.json'),
      path.join(os.homedir(), '.gemini/config.json'),
    ]
    const hasConfig = configPaths.some((p) => fs.existsSync(p))
    if (!hasConfig && !process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
      return {
        authenticated: false,
        errorMessage: 'Gemini CLI is not authenticated. Run `gemini auth login` or set GEMINI_API_KEY and try again.',
      }
    }
    return { authenticated: true }
  }

  if (backend === 'copilot') {
    // Check for GitHub token in env first
    if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.COPILOT_GITHUB_TOKEN) {
      return { authenticated: true }
    }
    // Try `gh auth status` as fallback (copilot inherits gh auth)
    try {
      const probe = spawnSync('gh', ['auth', 'status'], {
        cwd, env, encoding: 'utf-8', timeout: 8000,
      })
      const probeText = `${probe.stdout || ''}\n${probe.stderr || ''}`.toLowerCase()
      if ((probe.status ?? 1) === 0 || probeText.includes('logged in')) {
        return { authenticated: true }
      }
    } catch { /* gh may not be installed */ }

    // Fall back to config file check
    const configPaths = [
      path.join(os.homedir(), '.copilot/config.json'),
      path.join(os.homedir(), '.config/copilot/config.json'),
    ]
    const hasConfig = configPaths.some((p) => fs.existsSync(p))
    if (!hasConfig) {
      return {
        authenticated: false,
        errorMessage: 'Copilot CLI is not authenticated. Run `copilot /login`, `gh auth login`, or set GH_TOKEN and try again.',
      }
    }
    return { authenticated: true }
  }

  return { authenticated: true }
}

// ---------------------------------------------------------------------------
// Abort Signal Helper
// ---------------------------------------------------------------------------

/**
 * Attach an abort signal handler to a child process.
 * Extracted from claude-cli.ts for reuse across all CLI providers.
 */
export function attachAbortHandler(proc: ChildProcess, signal?: AbortSignal): void {
  if (!signal) return
  if (signal.aborted) {
    proc.kill()
    return
  }
  signal.addEventListener('abort', () => { proc.kill() }, { once: true })
}

// ---------------------------------------------------------------------------
// Config File Symlinker
// ---------------------------------------------------------------------------

/** Default patterns for auth-relevant config files. */
const DEFAULT_CONFIG_PATTERNS = ['auth*', 'config*', '.credentials', '*.pem', '*.key', '*.json', '*.toml']

/**
 * Symlink (or copy as fallback) config files from sourceDir into targetDir.
 * Used when creating temp home dirs for system prompt injection (e.g., Codex CODEX_HOME).
 */
export function symlinkConfigFiles(
  sourceDir: string,
  targetDir: string,
  patterns?: string[],
): void {
  if (!fs.existsSync(sourceDir)) return
  fs.mkdirSync(targetDir, { recursive: true })

  const matchers = (patterns || DEFAULT_CONFIG_PATTERNS).map((p) => {
    const escaped = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    return new RegExp(`^${escaped}$`, 'i')
  })

  let entries: string[]
  try {
    entries = fs.readdirSync(sourceDir)
  } catch {
    return
  }

  for (const entry of entries) {
    if (!matchers.some((re) => re.test(entry))) continue
    const src = path.join(sourceDir, entry)
    const dest = path.join(targetDir, entry)
    if (fs.existsSync(dest)) continue

    try {
      fs.symlinkSync(src, dest)
    } catch {
      try {
        const stat = fs.statSync(src)
        if (stat.isFile()) {
          fs.copyFileSync(src, dest)
        } else if (stat.isDirectory()) {
          fs.cpSync(src, dest, { recursive: true })
        }
      } catch {
        log.warn('cli-utils', `Failed to link/copy config file: ${entry}`)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Provider Capability Descriptions
// ---------------------------------------------------------------------------

/** Human-readable descriptions of what each CLI provider excels at. */
export const CLI_PROVIDER_CAPABILITIES: Record<string, string> = {
  'claude-cli': 'multi-file code editing, refactoring, debugging, code review',
  'codex-cli': 'code generation, file creation, automated coding tasks',
  'opencode-cli': 'code analysis, generation across multiple LLM backends',
  'gemini-cli': 'code generation, analysis with Gemini models',
  'copilot-cli': 'code generation, analysis, multi-model support via GitHub Copilot',
}

/** Check if a provider ID is a CLI-based provider. */
export function isCliProvider(providerId: string): boolean {
  return providerId in CLI_PROVIDER_CAPABILITIES
}
