#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

const DEFAULT_BASE_URL = process.env.SWARMCLAW_URL || 'http://localhost:3456'
const DEFAULT_OUT_DIR = path.join(process.cwd(), 'data', 'autonomy-benchmarks')
const DEFAULT_MIN_SCORE = Number.parseFloat(process.env.AUTONOMY_BENCH_MIN_SCORE || '70')
const DEFAULT_PROBE_PROFILE = String(process.env.AUTONOMY_BENCH_PROFILE || 'full').trim() || 'full'

function supportsChildWrites(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probeDir = fs.mkdtempSync(path.join(dir, '.autonomy-bench-probe-'))
    fs.rmSync(probeDir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

function resolveWorkspaceRoot() {
  if (process.env.WORKSPACE_DIR) return process.env.WORKSPACE_DIR
  const external = path.join(process.env.HOME || '', '.swarmclaw', 'workspace')
  if (external && supportsChildWrites(external)) return external
  return path.join(process.cwd(), 'data', 'workspace')
}

const WORKSPACE_ROOT = resolveWorkspaceRoot()

const TOOL_ALIAS_GROUPS = [
  ['shell', 'execute_command', 'process_tool', 'process'],
  ['files', 'read_file', 'write_file', 'list_files', 'copy_file', 'move_file', 'delete_file', 'send_file'],
  ['edit_file'],
  ['web', 'web_search', 'web_fetch'],
  ['browser', 'openclaw_browser'],
  ['delegate', 'claude_code', 'codex_cli', 'opencode_cli', 'gemini_cli', 'delegate_to_claude_code', 'delegate_to_codex_cli', 'delegate_to_opencode_cli', 'delegate_to_gemini_cli'],
  ['manage_platform', 'manage_agents', 'manage_projects', 'manage_tasks', 'manage_schedules', 'manage_skills', 'manage_documents', 'manage_webhooks', 'manage_secrets', 'manage_sessions'],
  ['manage_connectors', 'connectors', 'connector_message_tool'],
  ['manage_chatrooms', 'chatroom'],
  ['spawn_subagent', 'subagent', 'delegate_to_agent'],
  ['manage_sessions', 'session_info', 'sessions_tool', 'whoami_tool', 'search_history_tool'],
  ['schedule', 'schedule_wake'],
  ['http', 'http_request'],
  ['memory', 'memory_tool'],
  ['sandbox', 'sandbox_exec', 'sandbox_list_runtimes'],
  ['wallet', 'wallet_tool'],
  ['monitor', 'monitor_tool'],
  ['sample_ui', 'show_plugin_card'],
  ['context_mgmt', 'context_status', 'context_summarize'],
  ['openclaw_workspace'],
  ['openclaw_nodes'],
  ['image_gen', 'generate_image'],
  ['email', 'send_email'],
  ['calendar', 'calendar_events'],
  ['replicate', 'replicate_run', 'replicate_models'],
]

const TOOL_CANONICAL_MAP = (() => {
  const map = new Map()
  for (const group of TOOL_ALIAS_GROUPS) {
    const normalized = group.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean)
    const canonical = normalized[0]
    if (!canonical) continue
    for (const entry of normalized) map.set(entry, canonical)
  }
  return map
})()

const PROBE_BASE_TOOLS = [
  'shell',
  'process',
  'files',
  'edit_file',
  'web',
  'manage_connectors',
  'manage_sessions',
  'memory',
  'browser',
  'delegate',
  'claude_code',
  'codex_cli',
  'opencode_cli',
]

const PROJECT_OPERATION_TOOLS = [
  'manage_projects',
  'manage_schedules',
  'manage_secrets',
]

const PROBE_TOOL_PROFILES = {
  full: [...PROBE_BASE_TOOLS, 'manage_tasks'],
  no_task_management: [...PROBE_BASE_TOOLS],
  full_project_context: [...PROBE_BASE_TOOLS, 'manage_tasks', ...PROJECT_OPERATION_TOOLS],
  project_context_only: [...PROBE_BASE_TOOLS, ...PROJECT_OPERATION_TOOLS],
}

const OPENCLAW_SCENARIOS = [
  {
    id: 'openclaw_companion',
    prompt: 'Briefly introduce yourself and tell me one concrete way you can help me right now.',
    timeoutMs: 120_000,
  },
  {
    id: 'openclaw_action_request',
    prompt: 'Create a short 3-step plan to research and build a simple app with me, then execute step 1.',
    timeoutMs: 180_000,
  },
]

function usage() {
  console.log([
    'Usage: node scripts/benchmark-autonomy-harness.mjs [options]',
    '',
    'Local-only benchmark for SwarmClaw autonomy harness.',
    'This benchmark is intended to be run manually pre-release, not in CI.',
    '',
    'Options:',
    '  --base-url <url>        SwarmClaw base URL (default: http://localhost:3456)',
    '  --access-key <key>      Access key (fallback: SWARMCLAW_ACCESS_KEY, then .env.local ACCESS_KEY)',
    '  --out-dir <dir>         Output directory for benchmark reports',
    '  --min-score <0-100>     Exit non-zero when score is below this threshold (default: 70)',
    '  --profile <name>        Probe tool profile: full | no-task-management | full-project-context | project-context-only (default: full)',
    '  --session-scenarios <ids> Comma-separated session scenario IDs to run',
    '  --skip-chatrooms        Skip chatroom collaboration scenarios',
    '  --no-openclaw           Skip optional OpenClaw comparison probe',
    '  --keep-created          Keep created benchmark agent/session/chatrooms for inspection',
    '  --help                  Show this help',
  ].join('\n'))
}

function parseArgs(argv) {
  const options = {
    baseUrl: DEFAULT_BASE_URL,
    accessKey: '',
    outDir: DEFAULT_OUT_DIR,
    minScore: Number.isFinite(DEFAULT_MIN_SCORE) ? DEFAULT_MIN_SCORE : 70,
    profile: DEFAULT_PROBE_PROFILE,
    sessionScenarios: [],
    skipChatrooms: false,
    includeOpenclaw: true,
    keepCreated: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help') {
      usage()
      process.exit(0)
    }
    if (arg === '--base-url') {
      options.baseUrl = String(argv[++i] || '').trim()
      continue
    }
    if (arg === '--access-key') {
      options.accessKey = String(argv[++i] || '').trim()
      continue
    }
    if (arg === '--out-dir') {
      options.outDir = String(argv[++i] || '').trim()
      continue
    }
    if (arg === '--min-score') {
      const value = Number.parseFloat(String(argv[++i] || ''))
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        throw new Error('--min-score must be a number between 0 and 100')
      }
      options.minScore = value
      continue
    }
    if (arg === '--profile') {
      options.profile = String(argv[++i] || '').trim()
      continue
    }
    if (arg === '--session-scenarios') {
      options.sessionScenarios = String(argv[++i] || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
      continue
    }
    if (arg === '--skip-chatrooms') {
      options.skipChatrooms = true
      continue
    }
    if (arg === '--no-openclaw') {
      options.includeOpenclaw = false
      continue
    }
    if (arg === '--keep-created') {
      options.keepCreated = true
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  return options
}

function normalizeProbeProfileName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function resolveProbeProfile(value) {
  const normalized = normalizeProbeProfileName(value) || 'full'
  if (normalized === 'full') {
    return {
      id: 'full',
      label: 'Full tool profile',
      tools: [...PROBE_TOOL_PROFILES.full],
      hasTaskManagement: true,
      hasProjectContext: false,
      hasProjectTool: false,
      hasProjectOperations: false,
    }
  }
  if (normalized === 'no_task_management' || normalized === 'taskless') {
    return {
      id: 'no_task_management',
      label: 'No task management tool',
      tools: [...PROBE_TOOL_PROFILES.no_task_management],
      hasTaskManagement: false,
      hasProjectContext: false,
      hasProjectTool: false,
      hasProjectOperations: false,
    }
  }
  if (normalized === 'full_project_context' || normalized === 'project_context' || normalized === 'task_and_project_context') {
    return {
      id: 'full_project_context',
      label: 'Task management with active project context',
      tools: [...PROBE_TOOL_PROFILES.full_project_context],
      hasTaskManagement: true,
      hasProjectContext: true,
      hasProjectTool: true,
      hasProjectOperations: true,
    }
  }
  if (normalized === 'project_context_only' || normalized === 'project_only' || normalized === 'taskless_project_context') {
    return {
      id: 'project_context_only',
      label: 'Active project context without task management',
      tools: [...PROBE_TOOL_PROFILES.project_context_only],
      hasTaskManagement: false,
      hasProjectContext: true,
      hasProjectTool: true,
      hasProjectOperations: true,
    }
  }
  throw new Error(`Unknown --profile value "${value}". Valid values: full, no-task-management, full-project-context, project-context-only`)
}

function loadAccessKey(explicitKey) {
  if (explicitKey) return explicitKey
  if (process.env.SWARMCLAW_ACCESS_KEY) return process.env.SWARMCLAW_ACCESS_KEY
  const envPath = path.join(process.cwd(), '.env.local')
  if (!fs.existsSync(envPath)) {
    throw new Error('Access key missing. Pass --access-key or set SWARMCLAW_ACCESS_KEY/.env.local ACCESS_KEY')
  }
  const raw = fs.readFileSync(envPath, 'utf8')
  const line = raw.split('\n').find((entry) => entry.startsWith('ACCESS_KEY='))
  if (!line) {
    throw new Error('ACCESS_KEY not found in .env.local')
  }
  const key = line.slice('ACCESS_KEY='.length).trim()
  if (!key) {
    throw new Error('ACCESS_KEY is empty in .env.local')
  }
  return key
}

function toSlug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

function nowSlug() {
  return new Date().toISOString().replace(/[^\d]/g, '').slice(0, 14)
}

function summarize(text, max = 220) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim()
  return compact.length > max ? `${compact.slice(0, max - 3)}...` : compact
}

function stripRunNoise(text) {
  let cleaned = String(text || '').trim()
  // Session SSE can prefix multiple {"run":...} status envelopes before the actual assistant text.
  while (cleaned.startsWith('{"run":')) {
    const end = cleaned.indexOf('}}')
    if (end === -1) break
    cleaned = cleaned.slice(end + 2).trim()
  }
  return cleaned
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function round1(value) {
  return Math.round(value * 10) / 10
}

function normalizeToolName(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function canonicalizeToolName(value) {
  const normalized = normalizeToolName(value)
  if (!normalized) return ''
  return TOOL_CANONICAL_MAP.get(normalized) || normalized
}

function canonicalizeToolList(values) {
  if (!Array.isArray(values)) return []
  return [...new Set(values.map((value) => canonicalizeToolName(value)).filter(Boolean))]
}

function getAgentTools(agent) {
  if (Array.isArray(agent?.plugins) && agent.plugins.length > 0) return agent.plugins
  if (Array.isArray(agent?.tools) && agent.tools.length > 0) return agent.tools
  return []
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function writeTextFile(filePath, content) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, content)
}

function extractFirstId(text) {
  const match = String(text || '').match(/\b([a-f0-9]{8})\b/i)
  return match ? match[1] : null
}

function extractUploadUrls(text) {
  const matches = String(text || '').match(/\/api\/uploads\/[^\s)"'`]+/g) || []
  return [...new Set(matches)]
}

function gradeForScore(score) {
  if (score >= 90) return 'A'
  if (score >= 80) return 'B'
  if (score >= 70) return 'C'
  if (score >= 60) return 'D'
  return 'F'
}

async function fetchJson(client, method, route, body, timeoutMs = 25_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${client.baseUrl}${route}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-access-key': client.accessKey,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`${method} ${route} failed (${res.status}): ${summarize(text, 280)}`)
    }
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  } finally {
    clearTimeout(timer)
  }
}

async function postSse(client, route, body, timeoutMs = 180_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = Date.now()
  try {
    const res = await fetch(`${client.baseUrl}${route}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-access-key': client.accessKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      throw new Error(`POST ${route} failed (${res.status}): ${summarize(text, 280)}`)
    }

    const decoder = new TextDecoder()
    const reader = res.body.getReader()
    let buffer = ''
    let textAcc = ''
    let replacedText = ''
    const events = []

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx = buffer.indexOf('\n\n')
      while (idx !== -1) {
        const chunk = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const line = chunk
          .split('\n')
          .map((entry) => entry.trim())
          .find((entry) => entry.startsWith('data: '))
        if (line) {
          try {
            const ev = JSON.parse(line.slice(6))
            events.push(ev)
            if ((ev?.t === 'd' || ev?.t === 'md') && typeof ev.text === 'string') textAcc += ev.text
            if (ev?.t === 'r' && typeof ev.text === 'string') replacedText = ev.text
          } catch {
            // ignore malformed event chunk
          }
        }
        idx = buffer.indexOf('\n\n')
      }
    }

    return {
      events,
      durationMs: Date.now() - startedAt,
      text: replacedText || textAcc,
    }
  } finally {
    clearTimeout(timer)
  }
}

function setChatroomHarnessFlags(chatroomId, { chatMode, autoAddress }) {
  const dbPath = path.join(process.cwd(), 'data', 'swarmclaw.db')
  if (!fs.existsSync(dbPath)) return false
  let db = null
  try {
    db = new Database(dbPath)
    const row = db.prepare('SELECT data FROM chatrooms WHERE id = ?').get(chatroomId)
    if (!row?.data) return false
    const parsed = JSON.parse(row.data)
    parsed.chatMode = chatMode
    parsed.autoAddress = autoAddress
    parsed.updatedAt = Date.now()
    db.prepare('UPDATE chatrooms SET data = ? WHERE id = ?').run(JSON.stringify(parsed), chatroomId)
    return true
  } catch {
    return false
  } finally {
    if (db) db.close()
  }
}

function collectToolStats(events) {
  const toolCalls = events
    .filter((event) => event?.t === 'tool_call')
    .map((event) => String(event.toolName || 'unknown'))

  const toolErrors = events
    .filter((event) => event?.t === 'tool_result')
    .map((event) => event?.toolOutput)
    .filter((value) => typeof value === 'string' && /^Error:/i.test(value.trim()))
    .map((value) => summarize(value, 180))

  const streamErrors = events
    .filter((event) => event?.t === 'err')
    .map((event) => summarize(event.text || 'unknown error', 180))

  return { toolCalls, toolErrors, streamErrors }
}

function containsEmpathy(text) {
  return /\b(i hear you|i understand|that sounds hard|you are not alone|i am here|with you|sorry you|overwhelmed)\b/i.test(String(text || ''))
}

function containsActionableStep(text) {
  return /\b(next step|first step|we can|let's|right now|today|do this)\b/i.test(String(text || ''))
}

function isoToLongDate(isoDate) {
  const stamp = new Date(`${isoDate}T00:00:00Z`)
  if (Number.isNaN(stamp.getTime())) return isoDate
  return stamp.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

function mentionsDate(text, isoDate) {
  const source = String(text || '').toLowerCase()
  const iso = String(isoDate || '').toLowerCase()
  const longForm = isoToLongDate(isoDate).toLowerCase()
  return source.includes(iso) || source.includes(longForm)
}

function listBenchmarkTasksByTitle(tasks, titleIncludes) {
  return Object.values(tasks || {}).filter((row) =>
    row
    && typeof row === 'object'
    && String(row.title || '').includes(titleIncludes),
  )
}

async function waitForBenchmarkTasks(client, titleIncludes, predicate, timeoutMs = 90_000) {
  const startedAt = Date.now()
  let lastMatching = []
  while (Date.now() - startedAt < timeoutMs) {
    const tasks = await fetchJson(client, 'GET', '/api/tasks')
    lastMatching = listBenchmarkTasksByTitle(tasks, titleIncludes)
    if (predicate(lastMatching)) return lastMatching
    await sleep(1500)
  }
  return lastMatching
}

function countMemoriesContaining(needle) {
  const dbPath = path.join(process.cwd(), 'data', 'memory.db')
  if (!fs.existsSync(dbPath)) return 0
  let db = null
  try {
    db = new Database(dbPath, { readonly: true })
    const like = `%${needle}%`
    const row = db
      .prepare('SELECT COUNT(*) AS count FROM memories WHERE content LIKE ? OR title LIKE ?')
      .get(like, like)
    return Number(row?.count || 0)
  } catch {
    return 0
  } finally {
    if (db) db.close()
  }
}

async function prepareWorkspaceFixture(client, runTag, profile, createdIds) {
  const metadata = {
    projectName: 'HarborPilot Dispatch',
    objective: 'Reduce incident handoff chaos and prove a lightweight operator workflow that can expand into inbox-driven ops automation.',
    targetUser: 'marina operations managers',
    pilotPriorities: ['SMS outage handling', 'dock reassignment'],
    openObjectives: [
      'publish a triage research brief',
      'prepare credential bootstrap for ops inbox workflows',
    ],
    capabilityHints: [
      'research',
      'build',
      'web browsing',
      'credential bootstrapping',
      'goal tracking',
    ],
    successMetrics: [
      'publish a handoff summary within 5 minutes of an incident update',
      'prepare one reusable operator playbook each pilot week',
    ],
    credentialRequirements: [
      'mockmail app password for operator inbox automation',
      'harbor metrics api token for pilot reporting',
    ],
    heartbeatPrompt: 'Review active pilot risks, inbox blockers, and the next operator action.',
    heartbeatIntervalSec: 1800,
    projectDescription: [
      'HarborPilot Dispatch is a B2B dock-operations workspace for marina operations managers.',
      'The first pilot is focused on SMS outage handling and dock reassignment during busy charter turnover.',
    ].join(' '),
    color: '#0f766e',
  }

  let project = null
  let workspaceRoot = ''
  if (profile.hasProjectContext) {
    project = await fetchJson(client, 'POST', '/api/projects', {
      name: metadata.projectName,
      description: metadata.projectDescription,
      color: metadata.color,
      objective: metadata.objective,
      audience: metadata.targetUser,
      priorities: metadata.pilotPriorities,
      openObjectives: metadata.openObjectives,
      capabilityHints: metadata.capabilityHints,
      successMetrics: metadata.successMetrics,
      credentialRequirements: metadata.credentialRequirements,
      heartbeatPrompt: metadata.heartbeatPrompt,
      heartbeatIntervalSec: metadata.heartbeatIntervalSec,
    })
    createdIds.projects.push(project.id)
    workspaceRoot = path.join(WORKSPACE_ROOT, 'projects', project.id)
  } else {
    workspaceRoot = path.join(WORKSPACE_ROOT, `autonomy-benchmark-${runTag}-${profile.id}`)
  }

  createdIds.workspaces.push(workspaceRoot)
  ensureDir(workspaceRoot)

  writeTextFile(path.join(workspaceRoot, 'README.md'), [
    '# Workspace Seed',
    '',
    'This workspace intentionally starts with partial product notes.',
    'Inspect the files, create concrete artifacts, and prefer moving the work forward over talking about it.',
  ].join('\n'))

  writeTextFile(path.join(workspaceRoot, 'docs', 'problem-notes.md'), [
    '# Problem Notes',
    '',
    '- Operators lose time during incident escalation and shift handoff.',
    '- Internal checklists are inconsistent, especially under time pressure.',
    '- The first deliverables should stay narrow and execution-oriented.',
  ].join('\n'))

  writeTextFile(path.join(workspaceRoot, 'docs', 'constraints.md'), [
    '# Constraints',
    '',
    '- Keep deliverables lightweight and testable.',
    '- Bias toward artifacts that can be reused in a kickoff or pilot review.',
    '- Assume the team needs clear assumptions and explicit risks, not generic strategy language.',
  ].join('\n'))

  writeTextFile(path.join(workspaceRoot, 'docs', 'interview-snippets.md'), [
    '# Interview Snippets',
    '',
    '> We keep losing context during handoff, and then incidents drag on longer than they should.',
    '> If a tool helps us recover faster, I care more about clarity than fancy dashboards.',
  ].join('\n'))

  return {
    workspaceRoot,
    project,
    projectName: metadata.projectName,
    targetUser: metadata.targetUser,
    pilotPriorities: [...metadata.pilotPriorities],
    openObjectives: [...metadata.openObjectives],
    capabilityHints: [...metadata.capabilityHints],
    successMetrics: [...metadata.successMetrics],
    credentialRequirements: [...metadata.credentialRequirements],
    heartbeatPrompt: metadata.heartbeatPrompt,
    heartbeatIntervalSec: metadata.heartbeatIntervalSec,
    objective: metadata.objective,
    projectDescription: metadata.projectDescription,
    paths: {
      moneyPlanPath: 'plans/money-plan.md',
      backlogPath: 'plans/project-backlog.md',
      researchBriefPath: 'docs/research-brief.md',
      launchDraftPath: 'docs/launch-brief-draft.md',
      launchCritiquePath: 'docs/launch-brief-critique.md',
      launchFinalPath: 'docs/launch-brief-final.md',
      inboxOpsPath: 'ops/inbox-ops-playbook.md',
      marketWatchPath: 'plans/risk-bounded-market-watch.md',
    },
  }
}

function buildSessionScenarios(runTag, delegateAgentId, profile, fixture) {
  const moneyTaskPrefix = `[Autonomy Probe ${runTag}] money-`
  const deliveryTaskPrefix = `[Autonomy Probe ${runTag}] harbor-`
  const inboxTaskTitle = `[Autonomy Probe ${runTag}] inbox-triage-playbook`
  const marketTaskPrefix = `[Autonomy Probe ${runTag}] market-`
  const resumeTaskPrefix = `[Autonomy Probe ${runTag}] resume-`
  const resumeSourceTaskTitle = `${resumeTaskPrefix}source`
  const resumeFollowupTaskTitle = `${resumeTaskPrefix}followup`
  const birthday = '2031-04-17'
  const anniversary = '2031-10-02'
  const recurringBug = `ws reconnect loop ${runTag}`
  const moneyPlanPath = fixture.paths.moneyPlanPath
  const backlogPath = fixture.paths.backlogPath
  const researchBriefPath = fixture.paths.researchBriefPath
  const launchDraftPath = fixture.paths.launchDraftPath
  const launchCritiquePath = fixture.paths.launchCritiquePath
  const launchFinalPath = fixture.paths.launchFinalPath
  const inboxOpsPath = fixture.paths.inboxOpsPath
  const marketWatchPath = fixture.paths.marketWatchPath
  const resumeSourcePath = 'docs/task-continuation-source.md'
  const resumeFollowupPath = 'docs/task-continuation-followup.md'
  const hasTaskManagement = Boolean(profile?.hasTaskManagement)
  const hasProjectContext = Boolean(profile?.hasProjectContext)
  const hasProjectTool = Boolean(profile?.hasProjectTool)
  const hasProjectOperations = Boolean(profile?.hasProjectOperations)
  const projectOpsPath = 'plans/project-ops-brief.md'
  const credentialPlanPath = 'ops/credential-bootstrap.md'
  const heartbeatPlanPath = 'ops/project-heartbeat.md'
  const activeProjectId = fixture.project?.id || null
  return [
    {
      id: 'task_continuation_resume',
      skill: 'task_followup_continuation',
      weight: 8,
      timeoutMs: 220_000,
      requiresTool: true,
      expectedTools: hasTaskManagement ? ['manage_tasks'] : ['files'],
      prompt: hasTaskManagement
        ? [
            'Set up a two-step continuation workflow using task management.',
            `Create exactly two queued tasks titled "${resumeSourceTaskTitle}" and "${resumeFollowupTaskTitle}".`,
            `Assign both tasks to agent "${delegateAgentId}".`,
            hasProjectContext ? 'If an active project exists, let the active project be used by default for both tasks.' : 'If no active project exists, do not fabricate a project link.',
            `The "${resumeSourceTaskTitle}" task should create "${resumeSourcePath}" with sections "Context" and "Next Step".`,
            `The "${resumeFollowupTaskTitle}" task should create "${resumeFollowupPath}" with sections "Continuation" and "Inherited Context", and it must mention "${resumeSourcePath}" inside the file.`,
            `Use "continueFromTaskId" on "${resumeFollowupTaskTitle}" so it follows "${resumeSourceTaskTitle}" and reuses the earlier task context when possible.`,
            'Confirm both task ids.',
          ].join(' ')
        : [
            'Task management is unavailable in this session.',
            `Write "${resumeSourcePath}" with sections "Context" and "Next Step".`,
            `Then write "${resumeFollowupPath}" with sections "Continuation" and "Inherited Context", and mention "${resumeSourcePath}" inside the file.`,
            'Confirm both file paths.',
          ].join(' '),
      semanticCheck: hasTaskManagement
        ? (result) => extractFirstId(result.response) !== null && /\btask\b/i.test(result.response)
        : (result) => result.response.includes(resumeSourcePath) && result.response.includes(resumeFollowupPath),
      externalCheckWeight: 0.35,
      postRunCheck: hasTaskManagement
        ? async ({ client }) => {
            const matching = await waitForBenchmarkTasks(
              client,
              resumeTaskPrefix,
              (rows) => rows.length >= 2 && rows.every((row) => ['completed', 'failed'].includes(String(row.status || ''))),
              120_000,
            )
            const sourceTask = matching.find((row) => String(row?.title || '') === resumeSourceTaskTitle) || null
            const followupTask = matching.find((row) => String(row?.title || '') === resumeFollowupTaskTitle) || null
            const sourceAbs = path.join(fixture.workspaceRoot, resumeSourcePath)
            const followupAbs = path.join(fixture.workspaceRoot, resumeFollowupPath)
            const followupText = fs.existsSync(followupAbs) ? fs.readFileSync(followupAbs, 'utf8') : ''
            const sameSession = Boolean(sourceTask?.sessionId && followupTask?.sessionId && sourceTask.sessionId === followupTask.sessionId)
            const reusedPriorSession = /reusing prior session/i.test(String(followupTask?.checkpoint?.note || ''))
            const inheritedContinuationContext = sameSession || reusedPriorSession
            const projectLinked = !hasProjectContext || !activeProjectId
              ? true
              : sourceTask?.projectId === activeProjectId && followupTask?.projectId === activeProjectId
            return {
              name: 'task_continuation_workflow_completed',
              passed: sourceTask?.status === 'completed'
                && followupTask?.status === 'completed'
                && Array.isArray(followupTask?.blockedBy)
                && followupTask.blockedBy.includes(sourceTask.id)
                && inheritedContinuationContext
                && fs.existsSync(sourceAbs)
                && fs.existsSync(followupAbs)
                && followupText.includes(resumeSourcePath)
                && projectLinked,
              details: {
                sourceTaskId: sourceTask?.id || null,
                followupTaskId: followupTask?.id || null,
                sourceStatus: sourceTask?.status || null,
                followupStatus: followupTask?.status || null,
                sameSession,
                reusedPriorSession,
                inheritedContinuationContext,
                projectLinked,
                sourceExists: fs.existsSync(sourceAbs),
                followupExists: fs.existsSync(followupAbs),
              },
            }
          }
        : async () => {
            const sourceAbs = path.join(fixture.workspaceRoot, resumeSourcePath)
            const followupAbs = path.join(fixture.workspaceRoot, resumeFollowupPath)
            const followupText = fs.existsSync(followupAbs) ? fs.readFileSync(followupAbs, 'utf8') : ''
            return {
              name: 'continuation_files_written',
              passed: fs.existsSync(sourceAbs)
                && fs.existsSync(followupAbs)
                && followupText.includes(resumeSourcePath),
              details: {
                sourceExists: fs.existsSync(sourceAbs),
                followupExists: fs.existsSync(followupAbs),
              },
            }
          },
    },
    {
      id: 'money_goal_workflow',
      skill: 'autonomous_goal_execution',
      weight: 8,
      timeoutMs: 220_000,
      requiresTool: true,
      expectedTools: hasTaskManagement ? ['web', 'manage_tasks', 'files'] : ['web', 'files'],
      prompt: hasTaskManagement
        ? [
            'A user says: "I want you to help me make money legally."',
            'Do one concrete research step.',
            `Create exactly two backlog tasks (not queued) titled "${moneyTaskPrefix}research" and "${moneyTaskPrefix}mvp" using the task-management capability.`,
            `Assign both tasks to agent "${delegateAgentId}" instead of yourself.`,
            hasProjectContext ? 'If an active project exists, link both tasks to it.' : 'If no active project exists, do not invent one.',
            `Write a short plan to "${moneyPlanPath}", and then confirm task IDs and file path.`,
          ].join(' ')
        : [
            'A user says: "I want you to help me make money legally."',
            'Do one concrete research step.',
            `Task management is intentionally unavailable in this session, so do not claim to create tasks.`,
            `Instead, write a short plan to "${moneyPlanPath}" with a "Backlog" section that contains exactly two bullet items titled "${moneyTaskPrefix}research" and "${moneyTaskPrefix}mvp".`,
            'Then confirm the file path and the two backlog item titles.',
          ].join(' '),
      semanticCheck: hasTaskManagement
        ? (result) =>
            /money-plan\.md/i.test(result.response) &&
            extractFirstId(result.response) !== null &&
            /\b(task|backlog)\b/i.test(result.response)
        : (result) =>
            /money-plan\.md/i.test(result.response) &&
            result.response.includes(`${moneyTaskPrefix}research`) &&
            result.response.includes(`${moneyTaskPrefix}mvp`),
      externalCheckWeight: hasTaskManagement ? 0.2 : 0.2,
      postRunCheck: hasTaskManagement
        ? async ({ client }) => {
            const tasks = await fetchJson(client, 'GET', '/api/tasks')
            const matching = listBenchmarkTasksByTitle(tasks, moneyTaskPrefix)
            const projectLinkedCount = hasProjectContext && fixture.project?.id
              ? matching.filter((row) => row.projectId === fixture.project.id).length
              : null
            return {
              name: 'money_tasks_created',
              passed: matching.length >= 2 && (!hasProjectContext || projectLinkedCount >= 2),
              details: {
                taskCount: matching.length,
                expectedAtLeast: 2,
                projectLinkedCount,
                expectedProjectId: fixture.project?.id || null,
              },
            }
          }
        : async () => {
            const planPath = path.join(fixture.workspaceRoot, moneyPlanPath)
            const planText = fs.existsSync(planPath) ? fs.readFileSync(planPath, 'utf8') : ''
            return {
              name: 'money_plan_backlog_written',
              passed: planText.includes(`${moneyTaskPrefix}research`) && planText.includes(`${moneyTaskPrefix}mvp`),
              details: {
                exists: fs.existsSync(planPath),
                planPath,
              },
            }
          },
    },
    {
      id: 'project_delivery_execution',
      skill: 'project_execution',
      weight: 10,
      timeoutMs: 220_000,
      requiresTool: true,
      expectedTools: hasTaskManagement ? ['manage_tasks', 'files'] : ['files'],
      prompt: hasTaskManagement
        ? [
            'You are working in the current workspace.',
            'Inspect the existing files before acting.',
            `Create exactly three backlog tasks titled "${deliveryTaskPrefix}research-brief", "${deliveryTaskPrefix}launch-checklist", and "${deliveryTaskPrefix}qa-pass".`,
            `Assign all three tasks to agent "${delegateAgentId}" instead of yourself.`,
            hasProjectContext ? 'If an active project exists, link all three tasks to it.' : 'If no active project exists, do not fabricate a project link.',
            `Then execute the first step immediately by creating "${researchBriefPath}" with sections "Target User", "Primary Pain", "Assumptions", and "Risks".`,
            'Under "Risks", include a markdown table with at least two rows.',
            'Finally confirm the file path and the task ids.',
          ].join(' ')
        : [
            'You are working in the current workspace.',
            'Inspect the existing files before acting.',
            'Task management is intentionally unavailable in this session, so do not claim to create tasks.',
            `Write "${backlogPath}" with exactly three bullet items titled "${deliveryTaskPrefix}research-brief", "${deliveryTaskPrefix}launch-checklist", and "${deliveryTaskPrefix}qa-pass".`,
            `Then execute the first step immediately by creating "${researchBriefPath}" with sections "Target User", "Primary Pain", "Assumptions", and "Risks".`,
            'Under "Risks", include a markdown table with at least two rows.',
            'Finally confirm the backlog file path and the research brief path.',
          ].join(' '),
      semanticCheck: hasTaskManagement
        ? (result) =>
            result.response.includes(researchBriefPath) &&
            extractFirstId(result.response) !== null
        : (result) =>
            result.response.includes(backlogPath) &&
            result.response.includes(researchBriefPath),
      externalCheckWeight: 0.15,
      postRunCheck: hasTaskManagement
        ? async ({ client }) => {
            const tasks = await fetchJson(client, 'GET', '/api/tasks')
            const matching = listBenchmarkTasksByTitle(tasks, deliveryTaskPrefix)
            const researchBriefAbs = path.join(fixture.workspaceRoot, researchBriefPath)
            const researchBrief = fs.existsSync(researchBriefAbs) ? fs.readFileSync(researchBriefAbs, 'utf8') : ''
            const projectLinkedCount = hasProjectContext && fixture.project?.id
              ? matching.filter((row) => row.projectId === fixture.project.id).length
              : null
            return {
              name: 'project_tasks_and_brief_created',
              passed: matching.length >= 3
                && researchBrief.includes('## Target User')
                && researchBrief.includes('## Risks')
                && /\|.+\|.+\|/.test(researchBrief)
                && (!hasProjectContext || projectLinkedCount >= 3),
              details: {
                taskCount: matching.length,
                expectedAtLeast: 3,
                projectLinkedCount,
                expectedProjectId: fixture.project?.id || null,
                researchBriefExists: fs.existsSync(researchBriefAbs),
              },
            }
          }
        : async () => {
            const backlogAbs = path.join(fixture.workspaceRoot, backlogPath)
            const researchBriefAbs = path.join(fixture.workspaceRoot, researchBriefPath)
            const backlogText = fs.existsSync(backlogAbs) ? fs.readFileSync(backlogAbs, 'utf8') : ''
            const researchBrief = fs.existsSync(researchBriefAbs) ? fs.readFileSync(researchBriefAbs, 'utf8') : ''
            return {
              name: 'project_backlog_and_brief_written',
              passed: backlogText.includes(`${deliveryTaskPrefix}research-brief`)
                && backlogText.includes(`${deliveryTaskPrefix}launch-checklist`)
                && backlogText.includes(`${deliveryTaskPrefix}qa-pass`)
                && researchBrief.includes('## Target User')
                && researchBrief.includes('## Risks')
                && /\|.+\|.+\|/.test(researchBrief),
              details: {
                backlogExists: fs.existsSync(backlogAbs),
                researchBriefExists: fs.existsSync(researchBriefAbs),
                backlogAbs,
                researchBriefAbs,
              },
            }
          },
    },
    {
      id: 'open_ended_iteration',
      skill: 'deliverable_iteration',
      weight: 10,
      timeoutMs: 220_000,
      requiresTool: true,
      expectedTools: ['files'],
      prompt: [
        'Create a first draft launch brief for the current workspace at',
        `"${launchDraftPath}".`,
        'Then write a short critique at',
        `"${launchCritiquePath}" that names at least two weaknesses in the draft.`,
        'Then revise the brief into',
        `"${launchFinalPath}" and make at least one concrete change because of that critique.`,
        'Inspect any existing files you need first.',
        'Report all three file paths and one specific thing you changed in the final version.',
      ].join(' '),
      semanticCheck: (result) =>
        result.response.includes(launchDraftPath)
        && result.response.includes(launchCritiquePath)
        && result.response.includes(launchFinalPath)
        && /\b(changed|revised|updated)\b/i.test(result.response),
      externalCheckWeight: 0.25,
      postRunCheck: async () => {
        const draftAbs = path.join(fixture.workspaceRoot, launchDraftPath)
        const critiqueAbs = path.join(fixture.workspaceRoot, launchCritiquePath)
        const finalAbs = path.join(fixture.workspaceRoot, launchFinalPath)
        const draftText = fs.existsSync(draftAbs) ? fs.readFileSync(draftAbs, 'utf8') : ''
        const critiqueText = fs.existsSync(critiqueAbs) ? fs.readFileSync(critiqueAbs, 'utf8') : ''
        const finalText = fs.existsSync(finalAbs) ? fs.readFileSync(finalAbs, 'utf8') : ''
        const critiqueLineCount = critiqueText
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.startsWith('- ') || /^\d+\./.test(line))
          .length
        return {
          name: 'iteration_artifacts_created',
          passed: fs.existsSync(draftAbs)
            && fs.existsSync(critiqueAbs)
            && fs.existsSync(finalAbs)
            && critiqueLineCount >= 2
            && draftText.trim().length > 0
            && finalText.trim().length > 0
            && draftText !== finalText,
          details: {
            draftExists: fs.existsSync(draftAbs),
            critiqueExists: fs.existsSync(critiqueAbs),
            finalExists: fs.existsSync(finalAbs),
            critiqueLineCount,
          },
        }
      },
    },
    {
      id: 'project_operating_system',
      skill: 'project_context',
      weight: 8,
      timeoutMs: 180_000,
      requiresTool: true,
      expectedTools: hasProjectTool ? ['manage_projects', 'files'] : ['files'],
      prompt: hasProjectTool && hasProjectContext
        ? [
            'Use the active project-management tool to strengthen the current project record before doing anything else.',
            `Set the project objective to "${fixture.objective}".`,
            `Set the open objectives to "${fixture.openObjectives[0]}" and "${fixture.openObjectives[1]}".`,
            `Set the operating modes to "${fixture.capabilityHints.join('", "')}".`,
            `Set the credential requirements to "${fixture.credentialRequirements.join('", "')}".`,
            `Set the preferred heartbeat prompt to "${fixture.heartbeatPrompt}" and heartbeat interval to ${fixture.heartbeatIntervalSec} seconds.`,
            `Then write "${projectOpsPath}" with sections "Objective", "Open Objectives", "Operating Modes", "Credential Requirements", and "Heartbeat".`,
            'Confirm the active project id and the file path.',
          ].join(' ')
        : [
            'Project-management tooling is unavailable in this session.',
            `Write "${projectOpsPath}" with sections "Objective", "Open Objectives", "Operating Modes", "Credential Requirements", and "Heartbeat".`,
            `Use these exact values: objective "${fixture.objective}", open objectives "${fixture.openObjectives[0]}" and "${fixture.openObjectives[1]}", operating modes "${fixture.capabilityHints.join('", "')}", credential requirements "${fixture.credentialRequirements.join('", "')}", and heartbeat "${fixture.heartbeatPrompt}" every ${fixture.heartbeatIntervalSec} seconds.`,
            'Confirm the file path.',
          ].join(' '),
      semanticCheck: hasProjectTool && hasProjectContext
        ? (result) => result.response.includes(projectOpsPath) && (activeProjectId ? result.response.includes(activeProjectId) : true)
        : (result) => result.response.includes(projectOpsPath),
      externalCheckWeight: 0.3,
      postRunCheck: hasProjectTool && hasProjectContext
        ? async ({ client }) => {
            const project = await fetchJson(client, 'GET', `/api/projects/${encodeURIComponent(activeProjectId)}`)
            const projectOpsAbs = path.join(fixture.workspaceRoot, projectOpsPath)
            const text = fs.existsSync(projectOpsAbs) ? fs.readFileSync(projectOpsAbs, 'utf8') : ''
            return {
              name: 'project_record_enriched',
              passed: project?.objective === fixture.objective
                && Array.isArray(project?.openObjectives)
                && project.openObjectives.includes(fixture.openObjectives[0])
                && Array.isArray(project?.credentialRequirements)
                && project.credentialRequirements.includes(fixture.credentialRequirements[0])
                && project?.heartbeatPrompt === fixture.heartbeatPrompt
                && Number(project?.heartbeatIntervalSec) === fixture.heartbeatIntervalSec
                && text.includes('## Objective')
                && text.includes('## Credential Requirements'),
              details: {
                projectId: activeProjectId,
                projectOpsExists: fs.existsSync(projectOpsAbs),
              },
            }
          }
        : async () => {
            const projectOpsAbs = path.join(fixture.workspaceRoot, projectOpsPath)
            const text = fs.existsSync(projectOpsAbs) ? fs.readFileSync(projectOpsAbs, 'utf8') : ''
            return {
              name: 'project_ops_brief_written',
              passed: text.includes('## Objective')
                && text.includes(fixture.objective)
                && text.includes(fixture.credentialRequirements[0])
                && text.includes(fixture.heartbeatPrompt),
              details: {
                projectOpsExists: fs.existsSync(projectOpsAbs),
              },
            }
          },
    },
    {
      id: 'project_credentials_and_heartbeat',
      skill: 'project_operations',
      weight: 8,
      timeoutMs: 180_000,
      requiresTool: true,
      expectedTools: hasProjectOperations ? ['manage_secrets', 'manage_schedules', 'files'] : ['files'],
      prompt: hasProjectOperations && hasProjectContext
        ? [
            'Bootstrap lightweight project operations for the active project.',
            `Create one project-linked secret named "MockMail App Password ${runTag}" with service "mockmail" and value "${runTag}-mockmail-secret".`,
            `Create one active interval schedule named "Pilot heartbeat ${runTag}" with intervalMs ${fixture.heartbeatIntervalSec * 1000} and taskPrompt "Review active project goals, inbox blockers, and next operator action."`,
            'Omit projectId when possible so the active project is used by default.',
            `Then write "${credentialPlanPath}" with sections "Services", "Secrets", and "Heartbeat" that summarize what you configured.`,
            'Confirm the secret id, schedule id, and file path.',
          ].join(' ')
        : [
            'Project secret and schedule tooling is unavailable in this session.',
            `Write "${credentialPlanPath}" with sections "Services", "Secrets", and "Heartbeat" describing the credentials and recurring follow-up needed for an inbox-oriented operator workflow.`,
            `Also write "${heartbeatPlanPath}" with a recurring heartbeat recommendation every ${fixture.heartbeatIntervalSec} seconds and mention "${fixture.heartbeatPrompt}".`,
            'Confirm both file paths.',
          ].join(' '),
      semanticCheck: hasProjectOperations && hasProjectContext
        ? (result) => result.response.includes(credentialPlanPath) && extractFirstId(result.response) !== null
        : (result) => result.response.includes(credentialPlanPath) && result.response.includes(heartbeatPlanPath),
      externalCheckWeight: 0.3,
      postRunCheck: hasProjectOperations && hasProjectContext
        ? async ({ client }) => {
            const secrets = await fetchJson(client, 'GET', '/api/secrets')
            const schedules = await fetchJson(client, 'GET', '/api/schedules')
            const secretMatch = Object.values(secrets || {}).find((row) => String(row?.name || '') === `MockMail App Password ${runTag}`)
            const scheduleMatch = Object.values(schedules || {}).find((row) => String(row?.name || '') === `Pilot heartbeat ${runTag}`)
            const credentialPlanAbs = path.join(fixture.workspaceRoot, credentialPlanPath)
            const text = fs.existsSync(credentialPlanAbs) ? fs.readFileSync(credentialPlanAbs, 'utf8') : ''
            return {
              name: 'project_secret_and_schedule_created',
              passed: Boolean(secretMatch)
                && Boolean(scheduleMatch)
                && secretMatch?.projectId === activeProjectId
                && scheduleMatch?.projectId === activeProjectId
                && text.includes('## Secrets')
                && text.includes('## Heartbeat'),
              details: {
                secretId: secretMatch?.id || null,
                scheduleId: scheduleMatch?.id || null,
                projectId: activeProjectId,
                credentialPlanExists: fs.existsSync(credentialPlanAbs),
              },
            }
          }
        : async () => {
            const credentialPlanAbs = path.join(fixture.workspaceRoot, credentialPlanPath)
            const heartbeatPlanAbs = path.join(fixture.workspaceRoot, heartbeatPlanPath)
            const credentialText = fs.existsSync(credentialPlanAbs) ? fs.readFileSync(credentialPlanAbs, 'utf8') : ''
            const heartbeatText = fs.existsSync(heartbeatPlanAbs) ? fs.readFileSync(heartbeatPlanAbs, 'utf8') : ''
            return {
              name: 'credential_and_heartbeat_docs_written',
              passed: credentialText.includes('## Secrets')
                && heartbeatText.includes(fixture.heartbeatPrompt)
                && heartbeatText.includes(String(fixture.heartbeatIntervalSec)),
              details: {
                credentialPlanExists: fs.existsSync(credentialPlanAbs),
                heartbeatPlanExists: fs.existsSync(heartbeatPlanAbs),
              },
            }
          },
    },
    {
      id: 'inbox_operations_kickoff',
      skill: 'project_operations',
      weight: 8,
      timeoutMs: 200_000,
      requiresTool: true,
      expectedTools: hasProjectOperations ? ['manage_projects', 'manage_secrets', 'manage_schedules', 'files'] : ['files'],
      prompt: hasProjectOperations && hasProjectContext
        ? [
            'Treat the active project as an inbox-operations system.',
            'Add the capability hint "inbox triage" and the open objective "stand up inbox triage workflow".',
            `Create one project-linked secret named "Inbox OAuth Refresh ${runTag}" with service "mockmail" and value "${runTag}-inbox-refresh".`,
            `Create one active interval schedule named "Inbox triage review ${runTag}" with intervalMs 900000 and taskPrompt "Review unread inbox items, blockers, and next reply actions."`,
            hasTaskManagement
              ? `Also create exactly one backlog task titled "${inboxTaskTitle}" assigned to agent "${delegateAgentId}". Omit projectId so the active project is used by default.`
              : 'Task management is unavailable in this session, so do not claim to create tasks.',
            `Then write "${inboxOpsPath}" with sections "Inbox Goals", "Credential Bootstrap", "Heartbeat Cadence", and "Failure Modes".`,
            'Confirm the file path and any created ids.',
          ].join(' ')
        : [
            'Project operations tooling is unavailable in this session.',
            'Do not claim to create real secrets, schedules, or project updates.',
            `Write "${inboxOpsPath}" with sections "Inbox Goals", "Credential Bootstrap", "Heartbeat Cadence", and "Failure Modes" for a lightweight operator inbox workflow.`,
            'Confirm the file path.',
          ].join(' '),
      semanticCheck: (result) => result.response.includes(inboxOpsPath),
      externalCheckWeight: 0.3,
      postRunCheck: hasProjectOperations && hasProjectContext
        ? async ({ client }) => {
            const projects = await fetchJson(client, 'GET', `/api/projects/${encodeURIComponent(activeProjectId)}`)
            const secrets = await fetchJson(client, 'GET', '/api/secrets')
            const schedules = await fetchJson(client, 'GET', '/api/schedules')
            const tasks = hasTaskManagement ? await fetchJson(client, 'GET', '/api/tasks') : null
            const secretMatch = Object.values(secrets || {}).find((row) => String(row?.name || '') === `Inbox OAuth Refresh ${runTag}`)
            const scheduleMatch = Object.values(schedules || {}).find((row) => String(row?.name || '') === `Inbox triage review ${runTag}`)
            const taskMatch = hasTaskManagement
              ? Object.values(tasks || {}).find((row) => String(row?.title || '') === inboxTaskTitle)
              : null
            const inboxOpsAbs = path.join(fixture.workspaceRoot, inboxOpsPath)
            const text = fs.existsSync(inboxOpsAbs) ? fs.readFileSync(inboxOpsAbs, 'utf8') : ''
            return {
              name: 'inbox_ops_seeded',
              passed: Array.isArray(projects?.capabilityHints)
                && projects.capabilityHints.includes('inbox triage')
                && Array.isArray(projects?.openObjectives)
                && projects.openObjectives.includes('stand up inbox triage workflow')
                && secretMatch?.projectId === activeProjectId
                && scheduleMatch?.projectId === activeProjectId
                && (!hasTaskManagement || (taskMatch?.projectId === activeProjectId))
                && text.includes('## Inbox Goals')
                && text.includes('## Credential Bootstrap')
                && text.includes('## Heartbeat Cadence')
                && text.includes('## Failure Modes'),
              details: {
                projectId: activeProjectId,
                secretId: secretMatch?.id || null,
                scheduleId: scheduleMatch?.id || null,
                taskId: taskMatch?.id || null,
                inboxOpsExists: fs.existsSync(inboxOpsAbs),
              },
            }
          }
        : async () => {
            const inboxOpsAbs = path.join(fixture.workspaceRoot, inboxOpsPath)
            const text = fs.existsSync(inboxOpsAbs) ? fs.readFileSync(inboxOpsAbs, 'utf8') : ''
            return {
              name: 'inbox_ops_playbook_written',
              passed: text.includes('## Inbox Goals')
                && text.includes('## Credential Bootstrap')
                && text.includes('## Heartbeat Cadence')
                && text.includes('## Failure Modes'),
              details: {
                inboxOpsExists: fs.existsSync(inboxOpsAbs),
              },
            }
          },
    },
    {
      id: 'market_watch_planning',
      skill: 'autonomous_goal_execution',
      weight: 8,
      timeoutMs: 190_000,
      requiresTool: true,
      expectedTools: hasTaskManagement
        ? (hasProjectTool ? ['manage_projects', 'manage_tasks', 'files'] : ['manage_tasks', 'files'])
        : (hasProjectTool ? ['manage_projects', 'files'] : ['files']),
      prompt: hasProjectTool && hasProjectContext
        ? [
            'A user says "manage my trading research for me", but keep the work research-only and do not place trades or claim real execution.',
            'Use the active project as the durable goal tracker.',
            'Add the open objective "maintain a research-only market watch" and the success metric "publish one risk-bounded market memo per week".',
            hasTaskManagement
              ? `Create exactly two backlog tasks titled "${marketTaskPrefix}signal-review" and "${marketTaskPrefix}memo". Assign both to agent "${delegateAgentId}" and let the active project be used by default.`
              : 'Task management is unavailable in this session, so do not claim to create tasks.',
            `Then write "${marketWatchPath}" with sections "Guardrails", "Signals", "Research Cadence", and "Next Review".`,
            'Confirm the file path and any created ids.',
          ].join(' ')
        : hasTaskManagement
          ? [
              'A user says "manage my trading research for me", but keep the work research-only and do not place trades or claim real execution.',
              `Create exactly two backlog tasks titled "${marketTaskPrefix}signal-review" and "${marketTaskPrefix}memo".`,
              `Assign both to agent "${delegateAgentId}".`,
              `Then write "${marketWatchPath}" with sections "Guardrails", "Signals", "Research Cadence", and "Next Review".`,
              'Confirm the task ids and file path.',
            ].join(' ')
          : [
              'A user says "manage my trading research for me", but keep the work research-only and do not place trades or claim real execution.',
              `Write "${marketWatchPath}" with sections "Guardrails", "Signals", "Research Cadence", and "Next Review".`,
              'Confirm the file path.',
            ].join(' '),
      semanticCheck: (result) => result.response.includes(marketWatchPath),
      externalCheckWeight: 0.3,
      postRunCheck: async ({ client }) => {
        const marketWatchAbs = path.join(fixture.workspaceRoot, marketWatchPath)
        const text = fs.existsSync(marketWatchAbs) ? fs.readFileSync(marketWatchAbs, 'utf8') : ''
        const tasks = hasTaskManagement ? await fetchJson(client, 'GET', '/api/tasks') : null
        const matchingTasks = hasTaskManagement ? listBenchmarkTasksByTitle(tasks, marketTaskPrefix) : []
        const project = hasProjectTool && hasProjectContext && activeProjectId
          ? await fetchJson(client, 'GET', `/api/projects/${encodeURIComponent(activeProjectId)}`)
          : null
        const projectLinkedCount = hasProjectContext && activeProjectId
          ? matchingTasks.filter((row) => row.projectId === activeProjectId).length
          : null
        return {
          name: 'market_watch_plan_seeded',
          passed: text.includes('## Guardrails')
            && text.includes('## Signals')
            && text.includes('## Research Cadence')
            && text.includes('## Next Review')
            && (!hasTaskManagement || matchingTasks.length >= 2)
            && (!hasProjectTool || !hasProjectContext || (
              Array.isArray(project?.openObjectives)
              && project.openObjectives.includes('maintain a research-only market watch')
              && Array.isArray(project?.successMetrics)
              && project.successMetrics.includes('publish one risk-bounded market memo per week')
              && (!hasTaskManagement || projectLinkedCount >= 2)
            )),
          details: {
            marketWatchExists: fs.existsSync(marketWatchAbs),
            taskCount: matchingTasks.length,
            projectLinkedCount,
            projectId: activeProjectId,
          },
        }
      },
    },
    {
      id: 'news_media_delivery',
      skill: 'research_delivery',
      weight: 8,
      timeoutMs: 220_000,
      requiresTool: true,
      expectedTools: ['web', 'browser', 'manage_connectors'],
      prompt: [
        'A user asks:',
        '"Can you tell me more if there is any news related to the US-Iran war, and can you send me some screenshots and give me a summary and maybe send me a voice note about it?"',
        'Use live web research first.',
        'Then use the browser tool to capture at least one relevant screenshot from a source page.',
        'Give a concise summary of the latest relevant developments.',
        'If outbound delivery is possible, send the screenshot and a short voice note update through connector_message_tool.',
        'If no running connector is available, explicitly check that and report the delivery blocker instead of claiming the capability does not exist.',
        'In your final answer, include the screenshot upload URL exactly and say whether the voice note was sent or blocked after checking connectors.',
      ].join(' '),
      semanticCheck: (result) =>
        /\b(us|u\.s\.)\b/i.test(result.response)
        && /\biran\b/i.test(result.response)
        && /\b(summary|summarized|latest|update|updates|reported|developments)\b/i.test(result.response)
        && /\/api\/uploads\/[^\s)"'`]+\.(png|jpg|jpeg|webp)/i.test(result.response)
        && /\b(voice[\s-]?note|voice_sent|blocked|no running connectors|connector)\b/i.test(result.response),
      externalCheckWeight: 0.35,
      postRunCheck: async ({ client, row }) => {
        const screenshotUrls = extractUploadUrls(row.response)
          .filter((url) => /\.(png|jpg|jpeg|webp)(?:[?#].*)?$/i.test(url))
          .filter((url) => /\/api\/uploads\/(?:screenshot-|browser-)/i.test(url))
        const screenshotReachability = await Promise.all(
          screenshotUrls.slice(0, 3).map(async (url) => {
            try {
              const res = await fetch(`${client.baseUrl}${url}`, {
                headers: { 'x-access-key': client.accessKey },
              })
              return res.ok
            } catch {
              return false
            }
          }),
        )
        const connectorOutcome = /\b(voice[\s-]?note sent|voice_sent|no running connectors|set one up in the connectors panel|delivery blocker|delivery blocked|could not send (?:the )?voice(?:[\s-]?note)?|unable to send (?:the )?voice(?:[\s-]?note)?)\b/i.test(row.response)
        return {
          name: 'news_media_delivery_checked',
          passed: screenshotReachability.some(Boolean) && connectorOutcome,
          details: {
            screenshotUrls,
            reachableScreenshots: screenshotReachability.filter(Boolean).length,
            connectorOutcome,
          },
        }
      },
    },
    {
      id: 'project_context_alignment',
      skill: 'project_context',
      weight: 6,
      timeoutMs: 120_000,
      requiresTool: false,
      expectedTools: [],
      prompt: 'Without reading files or browsing the web, tell me the active project\'s exact name, objective, who it is for, the first two pilot priorities, and the first open objective. If there is no active project context, say that plainly.',
      semanticCheck: hasProjectContext
        ? (result) =>
            result.response.includes(fixture.projectName)
            && result.response.toLowerCase().includes(fixture.objective.toLowerCase())
            && result.response.toLowerCase().includes(fixture.targetUser.toLowerCase())
            && result.response.toLowerCase().includes(fixture.pilotPriorities[0].toLowerCase())
            && result.response.toLowerCase().includes(fixture.pilotPriorities[1].toLowerCase())
            && result.response.toLowerCase().includes(fixture.openObjectives[0].toLowerCase())
        : (result) => /\b(no active project|no current project|do not have active project context|no active project context)\b/i.test(result.response),
    },
    {
      id: 'session_history_recall',
      skill: 'session_management',
      weight: 8,
      timeoutMs: 140_000,
      requiresTool: true,
      expectedTools: ['manage_sessions'],
      prompt: `Use the session-management tool to inspect the recent history of this current session. Then tell me the exact "${moneyPlanPath}", "${researchBriefPath}", and "${launchFinalPath}" file paths created earlier in this chat, and mention that you checked session history.`,
      semanticCheck: (result) =>
        result.response.includes(moneyPlanPath) &&
        result.response.includes(researchBriefPath) &&
        result.response.includes(launchFinalPath) &&
        /\b(history|session history|recent history)\b/i.test(result.response),
    },
    {
      id: 'memory_significant_store',
      skill: 'memory',
      weight: 4,
      timeoutMs: 140_000,
      requiresTool: true,
      expectedTools: ['memory'],
      prompt: [
        'Store significant long-term memory for this user:',
        `birthday ${birthday}, anniversary ${anniversary}, recurring bug "${recurringBug}".`,
        'Save it explicitly as durable memory and confirm what was saved.',
      ].join(' '),
      semanticCheck: (result) =>
        mentionsDate(result.response, birthday) &&
        mentionsDate(result.response, anniversary) &&
        result.response.toLowerCase().includes(recurringBug.toLowerCase()),
      externalCheckWeight: 0.4,
      postRunCheck: async () => {
        const memoryCount = countMemoriesContaining(runTag)
        return {
          name: 'memory_rows_created',
          passed: memoryCount >= 1,
          details: { memoryCount, expectedAtLeast: 1 },
        }
      },
    },
    {
      id: 'memory_significant_recall',
      skill: 'memory',
      weight: 4,
      timeoutMs: 120_000,
      requiresTool: false,
      expectedTools: [],
      prompt: 'What significant personal details and recurring bug did I ask you to remember earlier in this conversation? Answer with exact values.',
      semanticCheck: (result) =>
        mentionsDate(result.response, birthday) &&
        mentionsDate(result.response, anniversary) &&
        result.response.toLowerCase().includes(recurringBug.toLowerCase()),
    },
  ]
}

const CHATROOM_SCENARIOS = [
  {
    id: 'sequential_project_split_execute',
    mode: 'sequential',
    autoAddress: true,
    weight: 10,
    timeoutMs: 240_000,
    requireAction: true,
    prompt: '@all We need to research and build a tiny app together. Split responsibilities by role and perform one concrete action now.',
  },
  {
    id: 'parallel_cross_delegate',
    mode: 'parallel',
    autoAddress: true,
    weight: 10,
    timeoutMs: 240_000,
    requireAction: true,
    requireDelegation: true,
    prompt: '@all Work as a team: each of you delegate one subtask to another specific agent and execute one concrete action now.',
  },
  {
    id: 'sequential_companion_team',
    mode: 'sequential',
    autoAddress: true,
    weight: 10,
    timeoutMs: 240_000,
    requireAction: true,
    requireEmpathy: true,
    prompt: '@all User says they are overwhelmed and lonely while trying to build a startup. Respond empathetically and provide one concrete next step each.',
  },
]

function evaluateSessionScenario(scenario, result, postCheck = null) {
  const called = new Set(canonicalizeToolList(result.toolCalls))
  const expected = canonicalizeToolList(scenario.expectedTools || [])
  const expectedMatched = expected.filter((toolName) => called.has(toolName)).length
  const toolCoverage = expected.length > 0
    ? expectedMatched / expected.length
    : (scenario.requiresTool ? (result.toolCalls.length > 0 ? 1 : 0) : 1)
  const noErrors = result.toolErrors.length === 0 && result.streamErrors.length === 0 ? 1 : 0
  const semantic = scenario.semanticCheck(result) ? 1 : 0
  const timely = result.durationMs <= scenario.timeoutMs ? 1 : 0
  const external = postCheck ? (postCheck.passed ? 1 : 0) : 1
  const externalWeight = Number.isFinite(Number(scenario.externalCheckWeight))
    ? Math.max(0, Math.min(0.5, Number(scenario.externalCheckWeight)))
    : 0
  const primaryScore = (toolCoverage * 0.5) + (noErrors * 0.2) + (semantic * 0.2) + (timely * 0.1)
  const blended = externalWeight > 0
    ? ((primaryScore * (1 - externalWeight)) + (external * externalWeight))
    : primaryScore

  let score = scenario.weight * blended
  if (scenario.requiresTool && result.toolCalls.length === 0) {
    score *= 0.35
  }
  score = round1(score)

  return {
    id: scenario.id,
    skill: scenario.skill,
    weight: scenario.weight,
    score,
    passed: score >= scenario.weight * 0.7,
    durationMs: result.durationMs,
    checks: {
      toolCoverage: round1(toolCoverage * 100),
      noErrors: Boolean(noErrors),
      semantic: Boolean(semantic),
      timely: Boolean(timely),
      external: postCheck ? Boolean(postCheck.passed) : null,
    },
    toolCalls: result.toolCalls,
    toolErrors: result.toolErrors,
    streamErrors: result.streamErrors,
    response: result.responseSummary || summarize(result.response, 340),
    postCheck,
  }
}

function evaluateChatroomScenario(scenario, result, expectedAgentIds) {
  const expected = expectedAgentIds.length
  const participation = expected > 0 ? Math.min(1, result.respondedAgentIds.length / expected) : 0
  const combinedText = result.newMessages
    .filter((msg) => msg.senderId !== 'user' && msg.senderId !== 'system')
    .map((msg) => msg.text)
    .join('\n')
  const splitSignal = /\b(assign|split|role|research|build|verify|delegate|owner)\b/i.test(combinedText) ? 1 : 0
  const actionSignal = result.toolCalls.length > 0
    || /\b(created|started|ran|executed|wrote|searched|configured|checked|listed|implemented|launched)\b/i.test(combinedText)
    || containsActionableStep(combinedText)
    ? 1 : 0
  const delegationSignal = result.newMessages.some((msg) =>
    msg.senderId !== 'user' &&
    msg.senderId !== 'system' &&
    (
      (Array.isArray(msg.mentions) && msg.mentions.length > 0)
      || /@\w+/.test(String(msg.text || ''))
      || /\bdelegate\b/i.test(String(msg.text || ''))
    )
  ) ? 1 : 0
  const empathySignal = containsEmpathy(combinedText) ? 1 : 0
  const noErrors = result.errors.length === 0 ? 1 : 0

  let score = 0
  if (scenario.requireEmpathy) {
    score = round1(scenario.weight * (
      (participation * 0.35) +
      (empathySignal * 0.3) +
      (actionSignal * 0.2) +
      (noErrors * 0.15)
    ))
  } else if (scenario.requireDelegation) {
    score = round1(scenario.weight * (
      (participation * 0.35) +
      (delegationSignal * 0.25) +
      (splitSignal * 0.2) +
      (actionSignal * 0.1) +
      (noErrors * 0.1)
    ))
  } else {
    score = round1(scenario.weight * (
      (participation * 0.4) +
      (splitSignal * 0.25) +
      (actionSignal * 0.25) +
      (noErrors * 0.1)
    ))
  }

  return {
    id: scenario.id,
    mode: scenario.mode,
    weight: scenario.weight,
    score,
    passed: score >= scenario.weight * 0.7,
    durationMs: result.durationMs,
    checks: {
      participation: round1(participation * 100),
      splitSignal: Boolean(splitSignal),
      actionSignal: Boolean(actionSignal),
      delegationSignal: Boolean(delegationSignal),
      empathySignal: Boolean(empathySignal),
      noErrors: Boolean(noErrors),
    },
    respondedAgentIds: result.respondedAgentIds,
    toolCalls: result.toolCalls,
    errors: result.errors,
    sampleMessages: result.newMessages.slice(0, 8).map((msg) => ({
      senderName: msg.senderName,
      text: summarize(msg.text, 180),
    })),
  }
}

function evaluateModelDiversity(participantAgents) {
  const normalizeTools = (tools) => {
    if (!Array.isArray(tools)) return ''
    return [...new Set(tools.map((tool) => String(tool || '').trim()).filter(Boolean))].sort().join(',')
  }
  const modelFamily = (model) => String(model || '').toLowerCase().split(/[:/@]/)[0] || String(model || '').toLowerCase()
  const uniqueModelKeys = new Set(
    participantAgents.map((agent) => `${agent.provider || 'unknown'}:${agent.model || 'unknown'}`)
  )
  const uniqueFamilyKeys = new Set(
    participantAgents.map((agent) => `${agent.provider || 'unknown'}:${modelFamily(agent.model || 'unknown')}`)
  )
  const uniqueCapabilityProfiles = new Set(
    participantAgents.map((agent) => [
      String(agent.provider || 'unknown').toLowerCase(),
      String(agent.model || 'unknown').toLowerCase(),
      normalizeTools(getAgentTools(agent)),
      agent.credentialId ? 'cred' : 'nocred',
      agent.apiEndpoint ? 'custom-endpoint' : 'default-endpoint',
    ].join('|'))
  )
  const uniqueToolProfiles = new Set(
    participantAgents.map((agent) => normalizeTools(getAgentTools(agent)))
  )
  const agentCount = Math.max(1, participantAgents.length)
  const modelDiversity = Math.min(1, uniqueModelKeys.size / agentCount)
  const familyDiversity = Math.min(1, uniqueFamilyKeys.size / agentCount)
  const capabilityDiversity = Math.min(1, uniqueCapabilityProfiles.size / agentCount)
  const toolProfileDiversity = Math.min(1, uniqueToolProfiles.size / agentCount)
  const roleHints = participantAgents.filter((agent) => {
    const text = `${agent.name || ''} ${agent.description || ''}`.toLowerCase()
    return /(research|build|assistant|planner|coder|qa|ops|orchestr)/.test(text)
  }).length
  const specialization = Math.min(1, roleHints / agentCount)
  const score = round1(10 * (
    (modelDiversity * 0.2)
    + (familyDiversity * 0.2)
    + (capabilityDiversity * 0.35)
    + (toolProfileDiversity * 0.1)
    + (specialization * 0.15)
  ))

  return {
    weight: 10,
    score,
    passed: score >= 5,
    checks: {
      uniqueModels: uniqueModelKeys.size,
      uniqueModelFamilies: uniqueFamilyKeys.size,
      uniqueCapabilityProfiles: uniqueCapabilityProfiles.size,
      uniqueToolProfiles: uniqueToolProfiles.size,
      agentCount,
      diversityPct: round1(modelDiversity * 100),
      familyDiversityPct: round1(familyDiversity * 100),
      capabilityDiversityPct: round1(capabilityDiversity * 100),
      toolProfileDiversityPct: round1(toolProfileDiversity * 100),
      specializationPct: round1(specialization * 100),
    },
    participants: participantAgents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      provider: agent.provider,
      model: agent.model,
      tools: getAgentTools(agent),
      hasCredential: Boolean(agent.credentialId),
      hasEndpoint: Boolean(agent.apiEndpoint),
    })),
  }
}

function evaluateOpenclawComparison(results) {
  if (!results || results.length === 0) {
    return { status: 'not_configured', available: false, notes: 'No OpenClaw agent configured.' }
  }
  const hasConnectionRefused = results.some((row) =>
    row.streamErrors.some((error) => /econnrefused/i.test(error))
  )
  const healthyTurns = results.filter((row) =>
    row.streamErrors.length === 0 && row.response && row.response.trim().length >= 20
  ).length
  if (hasConnectionRefused && healthyTurns === 0) {
    return { status: 'unreachable', available: false, notes: 'OpenClaw provider unreachable (connection refused).' }
  }
  return {
    status: 'available',
    available: true,
    healthyTurns,
    totalTurns: results.length,
    notes: healthyTurns === results.length
      ? 'OpenClaw comparison completed.'
      : 'OpenClaw comparison partially completed with errors.',
  }
}

function readLatestBenchmark(outDir, profileId) {
  if (!fs.existsSync(outDir)) return null
  const prefix = `autonomy-benchmark-${profileId}-`
  const files = fs.readdirSync(outDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .sort()
  if (files.length === 0) return null
  const latest = path.join(outDir, files[files.length - 1])
  try {
    const parsed = JSON.parse(fs.readFileSync(latest, 'utf8'))
    return { path: latest, report: parsed }
  } catch {
    return null
  }
}

function filterScenarioIds(rows, requestedIds) {
  if (!Array.isArray(requestedIds) || requestedIds.length === 0) return rows
  const wanted = new Set(requestedIds)
  return rows.filter((row) => wanted.has(row.id))
}

function renderMarkdown(report) {
  const lines = []
  lines.push('# Autonomy Harness Benchmark')
  lines.push('')
  lines.push(`- Generated: ${report.generatedAt}`)
  lines.push(`- Base URL: ${report.baseUrl}`)
  lines.push(`- Grade: **${report.summary.grade}** (${report.summary.totalScore}/${report.summary.maxScore})`)
  lines.push(`- Min Score Threshold: ${report.summary.minScore}`)
  lines.push(`- Result: ${report.summary.passed ? 'PASS' : 'FAIL'}`)
  lines.push('')
  lines.push('## Category Scores')
  lines.push('')
  lines.push('| Category | Score | Max | Pass |')
  lines.push('| --- | ---: | ---: | :---: |')
  lines.push(`| Session Skills | ${report.categoryScores.session.score} | ${report.categoryScores.session.max} | ${report.categoryScores.session.passed ? 'yes' : 'no'} |`)
  lines.push(`| Chatroom Collaboration | ${report.categoryScores.chatroom.score} | ${report.categoryScores.chatroom.max} | ${report.categoryScores.chatroom.passed ? 'yes' : 'no'} |`)
  lines.push(`| Collaboration Diversity | ${report.categoryScores.modelDiversity.score} | ${report.categoryScores.modelDiversity.max} | ${report.categoryScores.modelDiversity.passed ? 'yes' : 'no'} |`)
  lines.push('')
  lines.push('## Session Skills')
  lines.push('')
  lines.push('| Scenario | Skill | Score | Tool Coverage | Semantic | External | Errors |')
  lines.push('| --- | --- | ---: | ---: | :---: | :---: | :---: |')
  for (const row of report.sessionScenarios) {
    const external = row.checks.external === null ? 'n/a' : (row.checks.external ? 'yes' : 'no')
    lines.push(`| ${row.id} | ${row.skill} | ${row.score}/${row.weight} | ${row.checks.toolCoverage}% | ${row.checks.semantic ? 'yes' : 'no'} | ${external} | ${row.checks.noErrors ? 'yes' : 'no'} |`)
  }
  lines.push('')
  lines.push('## Chatroom Collaboration')
  lines.push('')
  lines.push('| Scenario | Mode | Score | Participation | Action | Delegation | Empathy | Errors |')
  lines.push('| --- | --- | ---: | ---: | :---: | :---: | :---: | :---: |')
  for (const row of report.chatroomScenarios) {
    lines.push(`| ${row.id} | ${row.mode} | ${row.score}/${row.weight} | ${row.checks.participation}% | ${row.checks.actionSignal ? 'yes' : 'no'} | ${row.checks.delegationSignal ? 'yes' : 'no'} | ${row.checks.empathySignal ? 'yes' : 'no'} | ${row.checks.noErrors ? 'yes' : 'no'} |`)
  }
  lines.push('')
  lines.push('## OpenClaw Comparison')
  lines.push('')
  lines.push(`- Status: ${report.openclaw.status}`)
  lines.push(`- Notes: ${report.openclaw.notes}`)
  lines.push('')
  if (report.previous) {
    lines.push('## Previous Run Delta')
    lines.push('')
    lines.push(`- Previous: ${report.previous.path}`)
    lines.push(`- Score Change: ${report.previous.deltaScore > 0 ? '+' : ''}${report.previous.deltaScore}`)
    lines.push(`- Grade Change: ${report.previous.prevGrade} -> ${report.summary.grade}`)
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}

async function runSessionTurn(client, sessionId, scenario) {
  const sse = await postSse(
    client,
    `/api/chats/${encodeURIComponent(sessionId)}/chat`,
    { message: scenario.prompt },
    scenario.timeoutMs,
  )
  const { toolCalls, toolErrors, streamErrors } = collectToolStats(sse.events)
  const cleanedResponse = stripRunNoise(sse.text)
  return {
    id: scenario.id,
    durationMs: sse.durationMs,
    toolCalls,
    toolErrors,
    streamErrors,
    response: cleanedResponse,
    responseSummary: summarize(cleanedResponse, 340),
  }
}

async function runChatroomTurn(client, chatroomId, scenario, expectedAgentIds) {
  const before = await fetchJson(client, 'GET', `/api/chatrooms/${encodeURIComponent(chatroomId)}`)
  const previousCount = Array.isArray(before?.messages) ? before.messages.length : 0
  const sse = await postSse(
    client,
    `/api/chatrooms/${encodeURIComponent(chatroomId)}/chat`,
    { senderId: 'user', text: scenario.prompt },
    scenario.timeoutMs,
  )
  const after = await fetchJson(client, 'GET', `/api/chatrooms/${encodeURIComponent(chatroomId)}`)
  const messages = Array.isArray(after?.messages) ? after.messages : []
  const newMessages = messages.slice(previousCount)
  const respondedAgentIds = [...new Set(
    newMessages
      .filter((msg) => msg && msg.senderId && msg.senderId !== 'user' && msg.senderId !== 'system')
      .map((msg) => String(msg.senderId)),
  )]
  const { toolCalls } = collectToolStats(sse.events)
  const errors = sse.events
    .filter((event) => event?.t === 'err')
    .map((event) => summarize(event.text || 'unknown error', 180))

  return {
    id: scenario.id,
    durationMs: sse.durationMs,
    expectedAgentIds,
    respondedAgentIds,
    toolCalls,
    errors,
    newMessages: newMessages.map((msg) => ({
      senderId: msg.senderId,
      senderName: msg.senderName,
      text: msg.text,
      mentions: Array.isArray(msg.mentions) ? msg.mentions : [],
    })),
  }
}

function selectChatroomAgentIds(agents, probeAgent) {
  const probeAgentId = probeAgent?.id
  const selected = []
  const normalizeTools = (tools) => {
    if (!Array.isArray(tools)) return ''
    return [...new Set(tools.map((tool) => String(tool || '').trim()).filter(Boolean))].sort().join(',')
  }
  const probeModelKey = `${probeAgent?.provider || ''}:${probeAgent?.model || ''}`.toLowerCase()
  const probeToolKey = normalizeTools(getAgentTools(probeAgent))
  const probeHasCred = Boolean(probeAgent?.credentialId)
  const probeHasEndpoint = Boolean(probeAgent?.apiEndpoint)
  const isHealthyCandidate = (agent) => {
    const provider = String(agent?.provider || '').toLowerCase()
    if (!provider) return false
    if (provider === 'openclaw') return false
    if (provider === 'ollama') return Boolean(agent?.apiEndpoint)
    if (provider.endsWith('-cli')) return true
    return Boolean(agent?.credentialId)
  }

  const candidates = Object.entries(agents)
    .filter(([id, agent]) => {
      if (!agent || id === probeAgentId) return false
      if (!isHealthyCandidate(agent)) return false
      const name = String(agent.name || '').toLowerCase()
      return !(name.includes('probe autonomy') || name.includes('[autonomy probe'))
    })
    .map(([id, agent]) => {
      const modelKey = `${agent.provider || ''}:${agent.model || ''}`.toLowerCase()
      const toolKey = normalizeTools(getAgentTools(agent))
      let score = 0
      if (modelKey !== probeModelKey) score += 4
      if (toolKey !== probeToolKey) score += 3
      if (Boolean(agent.credentialId) !== probeHasCred) score += 1
      if (Boolean(agent.apiEndpoint) !== probeHasEndpoint) score += 1
      const text = `${agent.name || ''} ${agent.description || ''}`.toLowerCase()
      if (/(research|build|assistant|planner|coder|qa|ops|orchestr)/.test(text)) score += 1
      return { id, score }
    })
    .sort((a, b) => b.score - a.score)

  // Keep assistant as first collaborator when available for consistent baseline UX.
  if (agents.default && probeAgentId !== 'default' && isHealthyCandidate(agents.default)) selected.push('default')

  for (const candidate of candidates) {
    if (selected.includes(candidate.id)) continue
    selected.push(candidate.id)
    if (selected.length >= 2) break
  }

  return [probeAgentId, ...selected].filter(Boolean).slice(0, 3)
}

async function cleanupBenchmarkArtifacts(client, ids, runTag) {
  const warnings = []

  for (const chatroomId of ids.chatrooms) {
    try {
      await fetchJson(client, 'DELETE', `/api/chatrooms/${encodeURIComponent(chatroomId)}`)
    } catch (err) {
      warnings.push(`cleanup chatroom ${chatroomId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  for (const sessionId of ids.sessions) {
    try {
      await fetchJson(client, 'DELETE', `/api/chats/${encodeURIComponent(sessionId)}`)
    } catch (err) {
      warnings.push(`cleanup session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  for (const agentId of ids.agents) {
    try {
      await fetchJson(client, 'DELETE', `/api/agents/${encodeURIComponent(agentId)}`)
    } catch (err) {
      warnings.push(`cleanup agent ${agentId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  try {
    const tasks = await fetchJson(client, 'GET', '/api/tasks')
    const rows = Object.values(tasks || {})
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const id = row.id
      const title = String(row.title || '')
      if (!id || !title.includes(`[Autonomy Probe ${runTag}]`)) continue
      await fetchJson(client, 'DELETE', `/api/tasks/${encodeURIComponent(id)}`)
    }
  } catch (err) {
    warnings.push(`cleanup benchmark tasks: ${err instanceof Error ? err.message : String(err)}`)
  }

  for (const projectId of ids.projects || []) {
    try {
      await fetchJson(client, 'DELETE', `/api/projects/${encodeURIComponent(projectId)}`)
    } catch (err) {
      warnings.push(`cleanup project ${projectId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  for (const workspaceRoot of ids.workspaces || []) {
    try {
      fs.rmSync(workspaceRoot, { recursive: true, force: true })
    } catch (err) {
      warnings.push(`cleanup workspace ${workspaceRoot}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return warnings
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const profile = resolveProbeProfile(options.profile)
  const accessKey = loadAccessKey(options.accessKey)
  const client = { baseUrl: options.baseUrl, accessKey }
  const runTag = toSlug(nowSlug())
  const probeTitle = `[Autonomy Probe ${runTag}]`
  const createdIds = { agents: [], sessions: [], chatrooms: [], projects: [], workspaces: [] }
  const warnings = []

  ensureDir(options.outDir)
  const previous = readLatestBenchmark(options.outDir, profile.id)

  await fetchJson(client, 'GET', '/api/auth')
  const agents = await fetchJson(client, 'GET', '/api/agents')
  const defaultAgent = agents?.default || Object.values(agents || {})[0]
  if (!defaultAgent) {
    throw new Error('No agent found. Configure at least one agent before running benchmark.')
  }

  const workspaceFixture = await prepareWorkspaceFixture(client, runTag, profile, createdIds)

  const probeAgent = await fetchJson(client, 'POST', '/api/agents', {
    name: `${probeTitle} Agent`,
    description: 'Temporary autonomy benchmark agent',
    systemPrompt: defaultAgent.systemPrompt || '',
    provider: defaultAgent.provider || 'openai',
    model: defaultAgent.model || 'gpt-4o',
    credentialId: defaultAgent.credentialId || null,
    apiEndpoint: defaultAgent.apiEndpoint || null,
    tools: profile.tools,
    platformAssignScope: 'all',
    memoryScopeMode: profile.hasProjectContext ? 'project' : 'auto',
    projectId: workspaceFixture.project?.id || undefined,
  })
  createdIds.agents.push(probeAgent.id)

  const probeSession = await fetchJson(client, 'POST', '/api/chats', {
    name: `${probeTitle} Session`,
    agentId: probeAgent.id,
    provider: probeAgent.provider,
    model: probeAgent.model,
    credentialId: probeAgent.credentialId || null,
    apiEndpoint: probeAgent.apiEndpoint || null,
    plugins: getAgentTools(probeAgent),
    user: 'benchmark',
    cwd: workspaceFixture.workspaceRoot,
  })
  createdIds.sessions.push(probeSession.id)

  const memoryRecallSession = await fetchJson(client, 'POST', '/api/chats', {
    name: `${probeTitle} Memory recall`,
    agentId: probeAgent.id,
    provider: probeAgent.provider,
    model: probeAgent.model,
    credentialId: probeAgent.credentialId || null,
    apiEndpoint: probeAgent.apiEndpoint || null,
    plugins: getAgentTools(probeAgent),
    user: 'benchmark',
    cwd: workspaceFixture.workspaceRoot,
  })
  createdIds.sessions.push(memoryRecallSession.id)

  const sessionScenarios = filterScenarioIds(
    buildSessionScenarios(runTag, defaultAgent.id, profile, workspaceFixture),
    options.sessionScenarios,
  )
  if (sessionScenarios.length === 0) {
    throw new Error('No session scenarios selected. Check --session-scenarios values.')
  }
  const sessionResults = []
  const sessionEvaluated = []
  for (const scenario of sessionScenarios) {
    const targetSessionId = scenario.id === 'memory_significant_recall'
      ? memoryRecallSession.id
      : probeSession.id
    const row = await runSessionTurn(client, targetSessionId, scenario)
    let postCheck = null
    if (typeof scenario.postRunCheck === 'function') {
      try {
        postCheck = await scenario.postRunCheck({
          client,
          runTag,
          sessionId: targetSessionId,
          row,
        })
      } catch (err) {
        postCheck = {
          name: 'post_check_error',
          passed: false,
          details: { error: err instanceof Error ? err.message : String(err) },
        }
      }
    }
    sessionResults.push(row)
    sessionEvaluated.push(evaluateSessionScenario(scenario, row, postCheck))
    await sleep(250)
  }

  const roomAgentIds = options.skipChatrooms ? [] : selectChatroomAgentIds(agents, probeAgent)
  const roomAgents = options.skipChatrooms
    ? []
    : roomAgentIds.map((id) => agents[id] || (id === probeAgent.id ? probeAgent : null)).filter(Boolean)
  const chatroomResults = []
  const chatroomEvaluated = []

  if (!options.skipChatrooms) {
    for (const scenario of CHATROOM_SCENARIOS) {
      const room = await fetchJson(client, 'POST', '/api/chatrooms', {
        name: `${probeTitle} ${scenario.mode} room`,
        description: `${scenario.mode} benchmark room`,
        agentIds: roomAgentIds,
      })
      createdIds.chatrooms.push(room.id)
      const modeSet = setChatroomHarnessFlags(room.id, {
        chatMode: scenario.mode,
        autoAddress: scenario.autoAddress,
      })
      if (!modeSet) {
        warnings.push(`Could not set chatroom mode flags for ${room.id}; benchmark fell back to room defaults.`)
      }
      const row = await runChatroomTurn(client, room.id, scenario, roomAgentIds)
      chatroomResults.push(row)
      chatroomEvaluated.push(evaluateChatroomScenario(scenario, row, roomAgentIds))
      await sleep(250)
    }
  } else {
    warnings.push('Chatroom scenarios skipped by --skip-chatrooms.')
  }

  const openclawAgent = options.includeOpenclaw
    ? Object.values(agents || {}).find((agent) => agent && String(agent.provider || '').toLowerCase() === 'openclaw')
    : null
  let openclawSession = null
  const openclawResults = []
  if (openclawAgent) {
    try {
      openclawSession = await fetchJson(client, 'POST', '/api/chats', {
        name: `${probeTitle} OpenClaw compare`,
        agentId: openclawAgent.id,
        provider: openclawAgent.provider,
        model: openclawAgent.model,
        credentialId: openclawAgent.credentialId || null,
        apiEndpoint: openclawAgent.apiEndpoint || null,
        plugins: getAgentTools(openclawAgent),
        user: 'benchmark',
      })
      createdIds.sessions.push(openclawSession.id)
      for (const scenario of OPENCLAW_SCENARIOS) {
        const row = await runSessionTurn(client, openclawSession.id, scenario)
        openclawResults.push(row)
        await sleep(250)
      }
    } catch (err) {
      warnings.push(`OpenClaw comparison skipped: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const modelDiversity = options.skipChatrooms
    ? {
        weight: 0,
        score: 0,
        passed: true,
        checks: {
          uniqueModels: 0,
          uniqueModelFamilies: 0,
          uniqueCapabilityProfiles: 0,
          uniqueToolProfiles: 0,
          agentCount: 0,
          diversityPct: 0,
          familyDiversityPct: 0,
          capabilityDiversityPct: 0,
          toolProfileDiversityPct: 0,
          specializationPct: 0,
        },
        participants: [],
      }
    : evaluateModelDiversity(roomAgents)
  const sessionScore = round1(sessionEvaluated.reduce((sum, row) => sum + row.score, 0))
  const sessionMax = round1(sessionEvaluated.reduce((sum, row) => sum + row.weight, 0))
  const chatroomScore = round1(chatroomEvaluated.reduce((sum, row) => sum + row.score, 0))
  const chatroomMax = round1(chatroomEvaluated.reduce((sum, row) => sum + row.weight, 0))
  const totalScore = round1(sessionScore + chatroomScore + modelDiversity.score)
  const maxScore = round1(sessionMax + chatroomMax + modelDiversity.weight)
  const normalizedScore = maxScore > 0 ? round1((totalScore / maxScore) * 100) : 0
  const grade = gradeForScore(normalizedScore)
  const openclawSummary = evaluateOpenclawComparison(openclawResults)
  const totalDurationMs = sessionResults.reduce((sum, row) => sum + row.durationMs, 0)
    + chatroomResults.reduce((sum, row) => sum + row.durationMs, 0)
  const totalToolCalls = sessionResults.reduce((sum, row) => sum + row.toolCalls.length, 0)
    + chatroomResults.reduce((sum, row) => sum + row.toolCalls.length, 0)

  let previousSummary = null
  if (previous?.report?.summary?.totalScore !== undefined) {
    const prevScore = Number(previous.report.summary.totalScore) || 0
    const deltaScore = round1(totalScore - prevScore)
    previousSummary = {
      path: previous.path,
      prevScore: round1(prevScore),
      prevGrade: String(previous.report.summary.grade || '?'),
      deltaScore,
    }
  }

  if (!options.keepCreated) {
    const cleanupWarnings = await cleanupBenchmarkArtifacts(client, createdIds, runTag)
    warnings.push(...cleanupWarnings)
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    baseUrl: client.baseUrl,
    runTag,
    profile: {
      id: profile.id,
      label: profile.label,
      tools: [...profile.tools],
      hasTaskManagement: profile.hasTaskManagement,
      hasProjectContext: profile.hasProjectContext,
      hasProjectTool: profile.hasProjectTool,
      hasProjectOperations: profile.hasProjectOperations,
      notes: profile.hasProjectContext
        ? 'Project context uses a real Project record, a workspace under WORKSPACE_ROOT/projects/<projectId>, structured project metadata, and project-linked tasks/schedules/secrets when those tools are enabled.'
        : 'This profile does not enable project context; comparisons isolate task management against file-based fallback workflows.',
    },
    options: {
      sessionScenarioIds: sessionScenarios.map((scenario) => scenario.id),
      skipChatrooms: options.skipChatrooms,
      includeOpenclaw: options.includeOpenclaw,
    },
    summary: {
      totalScore,
      maxScore,
      normalizedScore,
      grade,
      minScore: options.minScore,
      passed: normalizedScore >= options.minScore,
      totalDurationMs,
      totalToolCalls,
    },
    categoryScores: {
      session: {
        score: sessionScore,
        max: sessionMax,
        passed: sessionScore >= sessionMax * 0.7,
      },
      chatroom: {
        score: chatroomScore,
        max: chatroomMax,
        passed: chatroomScore >= chatroomMax * 0.7,
      },
      modelDiversity: {
        score: modelDiversity.score,
        max: modelDiversity.weight,
        passed: modelDiversity.passed,
      },
    },
    probe: {
      profileId: profile.id,
      probeAgent: { id: probeAgent.id, name: probeAgent.name, provider: probeAgent.provider, model: probeAgent.model },
      probeSession: { id: probeSession.id, name: probeSession.name },
      workspaceRoot: workspaceFixture.workspaceRoot,
      project: workspaceFixture.project ? {
        id: workspaceFixture.project.id,
        name: workspaceFixture.project.name,
        description: workspaceFixture.project.description,
      } : null,
      chatroomAgentIds: roomAgentIds,
    },
    sessionScenarios: sessionEvaluated,
    sessionRaw: sessionResults,
    chatroomScenarios: chatroomEvaluated,
    chatroomRaw: chatroomResults,
    modelDiversity,
    openclaw: {
      ...openclawSummary,
      sessionId: openclawSession?.id || null,
      results: openclawResults,
    },
    previous: previousSummary,
    warnings: [...warnings],
  }

  const fileStem = `autonomy-benchmark-${profile.id}-${runTag}`
  const jsonPath = path.join(options.outDir, `${fileStem}.json`)
  const markdownPath = path.join(options.outDir, `${fileStem}.md`)
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2))
  fs.writeFileSync(markdownPath, renderMarkdown(report))

  const summaryLine = `${report.summary.passed ? 'PASS' : 'FAIL'} ${report.summary.grade} ${report.summary.normalizedScore}/100`
  console.log(JSON.stringify({
    summary: summaryLine,
    jsonPath,
    markdownPath,
    openclaw: report.openclaw.status,
    warnings: report.warnings,
  }, null, 2))

  if (!report.summary.passed) {
    process.exit(2)
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err)
  console.error(JSON.stringify({ error: message }, null, 2))
  process.exit(1)
})
