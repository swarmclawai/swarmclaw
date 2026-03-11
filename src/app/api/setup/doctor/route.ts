import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { NextResponse } from 'next/server'
import { DATA_DIR } from '@/lib/server/data-dir'
import { loadAgents, loadCredentials, loadSettings } from '@/lib/server/storage'
import { dedup, errorMessage } from '@/lib/shared-utils'
import { detectDocker } from '@/lib/server/sandbox/docker-detect'

type CheckStatus = 'pass' | 'warn' | 'fail'

interface SetupCheck {
  id: string
  label: string
  status: CheckStatus
  detail: string
  required?: boolean
}

interface CommandResult {
  ok: boolean
  output: string
  error?: string
}

const RELEASE_TAG_RE = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

function run(command: string, args: string[], timeoutMs = 8_000): CommandResult {
  try {
    const result = spawnSync(command, args, {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: timeoutMs,
    })
    if (result.error) {
      return { ok: false, output: '', error: result.error.message }
    }
    if (typeof result.status === 'number' && result.status !== 0) {
      const err = (result.stderr || result.stdout || `exit ${result.status}`).trim()
      return { ok: false, output: '', error: err || `exit ${result.status}` }
    }
    return { ok: true, output: (result.stdout || '').trim() }
  } catch (err: unknown) {
    const message = errorMessage(err)
    return { ok: false, output: '', error: message }
  }
}

function getLatestStableTag(): string | null {
  const listed = run('git', ['tag', '--list', 'v*', '--sort=-v:refname'], 4_000)
  if (!listed.ok) return null
  const tags = listed.output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return tags.find((tag) => RELEASE_TAG_RE.test(tag)) || null
}

function commandExists(name: string): boolean {
  const lookup = process.platform === 'win32' ? 'where' : 'which'
  return run(lookup, [name], 3_000).ok
}

function pushCheck(
  checks: SetupCheck[],
  id: string,
  label: string,
  status: CheckStatus,
  detail: string,
  required = false,
) {
  checks.push({ id, label, status, detail, required })
}

function testDataWriteAccess(dataDir: string): { ok: boolean; error?: string } {
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    const probe = path.join(dataDir, `.doctor-write-${Date.now()}.tmp`)
    fs.writeFileSync(probe, 'ok', 'utf8')
    fs.unlinkSync(probe)
    return { ok: true }
  } catch (err: unknown) {
    const message = errorMessage(err)
    return { ok: false, error: message }
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const includeRemote = url.searchParams.get('remote') === '1'
  const checks: SetupCheck[] = []
  const actions: string[] = []
  const checkedAt = Date.now()

  const nodeVersion = process.versions.node
  const [nodeMajorRaw, nodeMinorRaw] = String(nodeVersion).split('.')
  const nodeMajor = Number.parseInt(nodeMajorRaw || '0', 10)
  const nodeMinor = Number.parseInt(nodeMinorRaw || '0', 10)
  if (nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 6)) {
    pushCheck(checks, 'node-version', 'Node.js version', 'pass', `Detected Node ${nodeVersion}.`, true)
  } else {
    pushCheck(checks, 'node-version', 'Node.js version', 'fail', `Detected Node ${nodeVersion}. Node 22.6+ is required.`, true)
    actions.push('Install Node.js 22.6 or newer from https://nodejs.org and rerun setup.')
  }

  const npmCheck = run('npm', ['--version'], 5_000)
  if (npmCheck.ok) {
    pushCheck(checks, 'npm', 'npm availability', 'pass', `npm ${npmCheck.output} is available.`, true)
  } else {
    pushCheck(checks, 'npm', 'npm availability', 'fail', npmCheck.error || 'npm was not found in PATH.', true)
    actions.push('Install npm and rerun `npm run setup:easy`.')
  }

  const dataWrite = testDataWriteAccess(DATA_DIR)
  if (dataWrite.ok) {
    pushCheck(checks, 'data-dir', 'Data directory permissions', 'pass', `Writable: ${DATA_DIR}`, true)
  } else {
    pushCheck(checks, 'data-dir', 'Data directory permissions', 'fail', dataWrite.error || `Cannot write to ${DATA_DIR}`, true)
    actions.push(`Fix filesystem permissions for ${DATA_DIR}.`)
  }

  const envFile = path.join(process.cwd(), '.env.local')
  if (fs.existsSync(envFile)) {
    pushCheck(checks, 'env-file', '.env.local', 'pass', '.env.local is present.')
  } else {
    pushCheck(checks, 'env-file', '.env.local', 'warn', '.env.local was not found yet. It will be created automatically on first run.')
    actions.push('Run `npm run dev` once to auto-generate ACCESS_KEY and CREDENTIAL_SECRET.')
  }

  const hasAccessKey = !!process.env.ACCESS_KEY?.trim()
  if (hasAccessKey) {
    pushCheck(checks, 'access-key', 'Access key', 'pass', 'ACCESS_KEY is configured.', true)
  } else {
    pushCheck(checks, 'access-key', 'Access key', 'fail', 'ACCESS_KEY is missing.', true)
    actions.push('Start the app once so SwarmClaw can generate ACCESS_KEY automatically.')
  }

  const hasCredentialSecret = !!process.env.CREDENTIAL_SECRET?.trim()
  if (hasCredentialSecret) {
    pushCheck(checks, 'credential-secret', 'Credential secret', 'pass', 'CREDENTIAL_SECRET is configured.', true)
  } else {
    pushCheck(checks, 'credential-secret', 'Credential secret', 'fail', 'CREDENTIAL_SECRET is missing.', true)
    actions.push('Start the app once so SwarmClaw can generate CREDENTIAL_SECRET automatically.')
  }

  const settings = loadSettings()
  if (settings?.setupCompleted === true) {
    pushCheck(checks, 'setup-wizard', 'Setup wizard', 'pass', 'Initial setup has been completed.')
  } else {
    pushCheck(checks, 'setup-wizard', 'Setup wizard', 'warn', 'Initial setup is not marked complete yet.')
    actions.push('Open the UI and finish the setup wizard at least once.')
  }

  const agents = Object.values(loadAgents() || {})
  if (agents.length > 0) {
    pushCheck(checks, 'agents', 'Agents', 'pass', `${agents.length} agent(s) configured.`)
  } else {
    pushCheck(checks, 'agents', 'Agents', 'warn', 'No agents found.')
    actions.push('Create a starter agent from the setup wizard.')
  }

  const credentials = Object.values(loadCredentials() || {})
  if (credentials.length > 0) {
    pushCheck(checks, 'credentials', 'Credentials', 'pass', `${credentials.length} credential(s) saved.`)
  } else {
    pushCheck(checks, 'credentials', 'Credentials', 'warn', 'No API credentials saved (OK for local-only Ollama).')
    actions.push('If using cloud providers, add an API key in the setup wizard or Settings → Providers.')
  }

  const optionalBinaries: Array<{ id: string; label: string; command: string }> = [
    { id: 'claude-cli', label: 'Claude Code CLI', command: 'claude' },
    { id: 'codex-cli', label: 'OpenAI Codex CLI', command: 'codex' },
    { id: 'opencode-cli', label: 'OpenCode CLI', command: 'opencode' },
    { id: 'google-workspace-cli', label: 'Google Workspace CLI', command: 'gws' },
  ]

  for (const binary of optionalBinaries) {
    const exists = commandExists(binary.command)
    pushCheck(
      checks,
      binary.id,
      binary.label,
      exists ? 'pass' : 'warn',
      exists
        ? `${binary.command} is installed.`
        : `${binary.command} is not installed (optional, only needed for ${binary.label} provider).`,
    )
  }

  const pluginSettings = (settings?.pluginSettings && typeof settings.pluginSettings === 'object')
    ? settings.pluginSettings as Record<string, Record<string, unknown>>
    : {}
  const googleWorkspaceSettings = (
    (pluginSettings.google_workspace && typeof pluginSettings.google_workspace === 'object')
      ? pluginSettings.google_workspace
      : null
  ) as Record<string, unknown> | null
  const googleWorkspaceConfigured = Boolean(
    googleWorkspaceSettings
    && (
      typeof googleWorkspaceSettings.accessToken === 'object'
      || typeof googleWorkspaceSettings.credentialsJson === 'object'
      || (typeof googleWorkspaceSettings.credentialsFile === 'string' && googleWorkspaceSettings.credentialsFile.trim())
    ),
  )
  pushCheck(
    checks,
    'google-workspace-auth',
    'Google Workspace plugin auth',
    googleWorkspaceConfigured ? 'pass' : 'warn',
    googleWorkspaceConfigured
      ? 'Google Workspace plugin settings include auth material.'
      : 'Google Workspace plugin auth is not configured yet (optional unless you plan to use the Google Workspace CLI tool).',
  )

  const docker = detectDocker()
  pushCheck(
    checks,
    'docker',
    'Docker (sandbox runtime)',
    docker.available ? 'pass' : 'warn',
    docker.available
      ? `Docker ${docker.version || ''} is available for container sandbox execution.`.trim()
      : 'Docker is not available. SwarmClaw will fall back to host execution until Docker Desktop is installed.',
  )
  if (!docker.available) {
    actions.push('Install Docker Desktop if you want shell, browser, and code execution to stay inside containers by default.')
  }

  const gitRootCheck = run('git', ['rev-parse', '--is-inside-work-tree'], 4_000)
  let localSha: string | null = null
  let remoteSha: string | null = null
  let behindBy = 0
  let workingTreeDirty = false

  if (!gitRootCheck.ok) {
    pushCheck(checks, 'git-repo', 'Git repository', 'warn', 'This directory is not a git repository. Auto-update checks are disabled.')
  } else {
    pushCheck(checks, 'git-repo', 'Git repository', 'pass', 'Git repository detected.')

    localSha = run('git', ['rev-parse', '--short', 'HEAD'], 4_000).output || null
    const dirty = run('git', ['status', '--porcelain'], 4_000)
    workingTreeDirty = !!dirty.output
    if (workingTreeDirty) {
      pushCheck(checks, 'git-dirty', 'Working tree cleanliness', 'warn', 'Uncommitted local changes detected.')
      actions.push('Commit or stash local changes before running automatic updates.')
    } else {
      pushCheck(checks, 'git-dirty', 'Working tree cleanliness', 'pass', 'Working tree is clean.')
    }

    if (includeRemote) {
      const fetch = run('git', ['fetch', '--tags', 'origin', '--quiet'], 12_000)
      if (!fetch.ok) {
        pushCheck(checks, 'git-remote', 'Remote update check', 'warn', fetch.error || 'Could not check remote release tags.')
      } else {
        const latestTag = getLatestStableTag()
        if (!latestTag) {
          pushCheck(checks, 'git-update', 'Update availability', 'warn', 'No stable release tags found yet; updater will fallback to main.')
        } else {
          const behind = run('git', ['rev-list', `HEAD..${latestTag}^{commit}`, '--count'], 4_000)
          behindBy = Number.parseInt(behind.output || '0', 10) || 0
          remoteSha = run('git', ['rev-parse', '--short', `${latestTag}^{commit}`], 4_000).output || localSha

          if (behindBy > 0) {
            pushCheck(checks, 'git-update', 'Update availability', 'warn', `${behindBy} commit(s) available to stable release ${latestTag}.`)
            actions.push('Run `npm run update:easy` or use the in-app update banner.')
          } else {
            pushCheck(checks, 'git-update', 'Update availability', 'pass', `Already on stable release ${latestTag} or newer.`)
          }
        }
      }
    } else {
      pushCheck(checks, 'git-remote', 'Remote update check', 'warn', 'Skipped (pass ?remote=1 to include remote stable-tag check).')
    }
  }

  const failedRequired = checks.filter((c) => c.required && c.status === 'fail').length
  const warnings = checks.filter((c) => c.status === 'warn').length
  const ok = failedRequired === 0
  const summary = ok
    ? (warnings > 0 ? `Setup mostly healthy with ${warnings} warning(s).` : 'Setup looks healthy.')
    : `Setup has ${failedRequired} required failure(s).`

  return NextResponse.json({
    ok,
    checkedAt,
    summary,
    checks,
    actions: dedup(actions),
    docker: {
      available: docker.available,
      version: docker.version || null,
    },
    git: {
      localSha,
      remoteSha,
      behindBy,
      dirty: workingTreeDirty,
    },
  })
}
