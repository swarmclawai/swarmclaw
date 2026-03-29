import type { ExtensionToolPlanning } from '@/types'
import { dedup } from '@/lib/shared-utils'
import { getExtensionManager } from './extensions'
import { getNativeCapabilityTools } from './native-capabilities'
import { canonicalizeExtensionId, expandExtensionIds } from './tool-aliases'

export const TOOL_CAPABILITY = {
  researchSearch: 'research.search',
  researchFetch: 'research.fetch',
  browserNavigate: 'browser.navigate',
  browserCapture: 'browser.capture',
  artifactPdf: 'artifact.pdf',
  deliveryMessage: 'delivery.message',
  deliveryMedia: 'delivery.media',
  deliveryVoiceNote: 'delivery.voice_note',
} as const

export interface ToolPlanningEntry {
  toolName: string
  capabilities: string[]
  disciplineGuidance: string[]
}

interface LegacyToolPlanningEntry extends ToolPlanningEntry {
  requestMatchers?: unknown
}

export interface ToolPlanningView {
  displayToolIds: string[]
  expandedExtensionIds: string[]
  entries: ToolPlanningEntry[]
  disciplineGuidance: string[]
  capabilityToTools: Map<string, string[]>
}

const CORE_TOOL_PLANNING: Record<string, LegacyToolPlanningEntry[]> = {
  files: [
    {
      toolName: 'files',
      capabilities: ['artifact.files'],
      disciplineGuidance: [
        'For `files`, include an explicit action whenever possible. Common patterns: `{"action":"list","dirPath":"."}`, `{"action":"read","filePath":"path/to/file.md"}`, and `{"action":"write","files":[{"path":"path/to/file.md","content":"..."}]}`.',
        'Prefer a single write call with multiple files over writing one file at a time.',
      ],
      requestMatchers: [],
    },
  ],
  shell: [
    {
      toolName: 'shell',
      capabilities: ['runtime.shell'],
      disciplineGuidance: [
        'For `shell`, use `{"action":"execute","command":"..."}` for commands and `{"action":"status","processId":"..."}` or `{"action":"log","processId":"..."}` for long-lived processes.',
        'Chain related commands in a single shell call using && to reduce round-trips. Avoid running the same build or test command repeatedly — if it fails, diagnose the error before retrying.',
      ],
      requestMatchers: [],
    },
  ],
  execute: [
    {
      toolName: 'execute',
      capabilities: ['runtime.execute'],
      disciplineGuidance: [
        'For `execute`, pass the full bash script in `{"code":"..."}`. Use it for sandboxed command execution, curl-based fetches, and one-shot scripts.',
        'Use `persistent=true` only when the agent is explicitly configured for host execution. Otherwise use `files` for persistent writes.',
      ],
      requestMatchers: [],
    },
  ],
  web: [
    {
      toolName: 'web_search',
      capabilities: [TOOL_CAPABILITY.researchSearch],
      disciplineGuidance: [
        'For `web_search`, use `{"query":"..."}` to research fresh information. For current events, breaking news, or "latest" requests, start with `web_search` before summarizing.',
        'Gather 2-3 key sources, then synthesize. Do not search-read-search-read in a loop.',
      ],
      requestMatchers: [
        {
          capability: TOOL_CAPABILITY.researchSearch,
          patterns: ['research', 'look up', 'find out', 'search for', 'compare', 'latest', 'news', 'headline', 'current event', 'recent update', 'update', 'updates', 'breaking', 'developments', 'keep watching', 'watch for', 'watching for', 'monitor', 'track', "what's new", 'what happened'],
          forbidLiteralUrl: true,
        },
      ],
    },
    {
      toolName: 'web_fetch',
      capabilities: [TOOL_CAPABILITY.researchFetch],
      disciplineGuidance: [
        'For `web_fetch`, use `{"url":"https://..."}` to read a specific page or article after you know the URL.',
        'Fetch the pages you need, then synthesize. Do not fetch-read-fetch-read in a loop.',
      ],
      requestMatchers: [
        {
          capability: TOOL_CAPABILITY.researchFetch,
          patterns: ['read', 'summarize', 'summarise', 'analyze', 'analyse', 'extract', 'review', 'article', 'page', 'url', 'link'],
          requireLiteralUrl: true,
        },
      ],
    },
  ],
  browser: [
    {
      toolName: 'browser',
      capabilities: [TOOL_CAPABILITY.browserNavigate, TOOL_CAPABILITY.browserCapture, TOOL_CAPABILITY.artifactPdf],
      disciplineGuidance: [
        'For `browser`, when the task includes a literal URL, pass that exact URL string to `{"action":"navigate","url":"..."}`. Do not invent placeholder URLs like `[Your URL]`, `Example_URL`, or `MockMailPage_URL`.',
        'For `browser` form work, prefer `{"action":"fill_form","fields":[{"element":"#email","value":"user@example.com"},{"element":"#password","value":"..."}]}`. A shorthand `form` object keyed by input id/name also works for simple forms.',
        'Use `browser` when the user asks for screenshots, visual proof, page capture, PDFs, or a rendered view of a page. `navigate` alone is not a screenshot.',
        'Limit browser navigations to what is needed. Each navigation is expensive. Plan your browser session: list the pages you need, visit each once, extract what you need.',
      ],
      requestMatchers: [
        {
          capability: TOOL_CAPABILITY.browserNavigate,
          patterns: ['browser', 'click', 'fill form', 'log in', 'login', 'navigate'],
          requireLiteralUrl: true,
        },
        {
          capability: TOOL_CAPABILITY.browserCapture,
          patterns: ['screenshot', 'screen shot', 'snapshot', 'page capture', 'visual proof', 'capture the page', 'rendered view'],
        },
        {
          capability: TOOL_CAPABILITY.artifactPdf,
          patterns: ['pdf', 'save as pdf', 'export pdf'],
        },
      ],
    },
  ],
  manage_connectors: [
    {
      toolName: 'connector_message_tool',
      capabilities: [TOOL_CAPABILITY.deliveryMessage, TOOL_CAPABILITY.deliveryMedia, TOOL_CAPABILITY.deliveryVoiceNote],
      disciplineGuidance: [
        'For outbound delivery, inspect available channels with `connector_message_tool` using `{"action":"list_running"}` before claiming something cannot be sent.',
        'Use `connector_message_tool` with `{"action":"send","message":"...","mediaPath":"..."}` for text/media and `{"action":"send_voice_note","voiceText":"..."}` for voice notes.',
        'If no channel or recipient is configured, explain that connector/channel setup is missing rather than claiming the capability does not exist.',
        'Check channel availability once with `list_running`, then send. Do not re-list channels between each message.',
      ],
      requestMatchers: [
        {
          capability: TOOL_CAPABILITY.deliveryMessage,
          patterns: ['send', 'share', 'deliver', 'message'],
        },
        {
          capability: TOOL_CAPABILITY.deliveryMedia,
          patterns: ['screenshot', 'screen shot', 'snapshot', 'image', 'photo', 'send file', 'send a file', 'pdf', 'attachment'],
        },
        {
          capability: TOOL_CAPABILITY.deliveryVoiceNote,
          patterns: ['voice note', 'voice-note', 'voicenote', 'voice memo', 'voice message', 'audio note', 'audio update', 'ptt'],
        },
      ],
    },
  ],
  http_request: [
    {
      toolName: 'http_request',
      capabilities: ['network.http'],
      disciplineGuidance: [
        'For `http_request`, send exact literal URLs from the task or from prior tool results. Keep JSON request bodies as raw JSON strings.',
        'If an API call fails, inspect the error before retrying with the same request. Do not retry the same failing call in a loop.',
      ],
      requestMatchers: [],
    },
  ],
  email: [
    {
      toolName: 'email',
      capabilities: ['delivery.email'],
      disciplineGuidance: [
        'For `email`, send mail with `{"action":"send","to":"user@example.com","subject":"...","body":"..."}`. If delivery depends on SMTP setup, check `{"action":"status"}` before claiming success.',
        'Compose the full message in one send call. Do not send partial drafts followed by corrections.',
      ],
      requestMatchers: [],
    },
  ],
  google_workspace: [
    {
      toolName: 'google_workspace',
      capabilities: ['workspace.google'],
      disciplineGuidance: [
        'For `google_workspace`, pass exact `gws` arguments in `{"args":[...]}` form. Prefer list/get/read commands first to confirm IDs and current state before mutating Drive, Docs, Sheets, Gmail, Calendar, or Chat resources.',
        'Use `params` and `jsonInput` for `--params` / `--json` payloads instead of packing raw JSON blobs into the `args` array.',
        'Do not call interactive `gws auth login` or `gws auth setup` from the agent. Use the extension settings or a pre-authenticated `gws` install.',
        'Confirm resource IDs with a single list/get call before mutating. Do not repeatedly list the same resources between edits.',
      ],
      requestMatchers: [
        {
          capability: 'workspace.google',
          patterns: ['google workspace', 'google docs', 'google doc', 'google sheets', 'spreadsheet', 'google drive', 'gmail', 'google calendar', 'google chat', 'workspace file', 'shared drive'],
        },
      ],
    },
  ],
  ask_human: [
    {
      toolName: 'ask_human',
      capabilities: ['human.input'],
      disciplineGuidance: [
        'For `ask_human`, when a workflow needs a code, approval, or out-of-band value from a person, do not guess or keep re-submitting blank forms. Use `{"action":"request_input","question":"..."}` and, for durable pauses, `{"action":"wait_for_reply","correlationId":"..."}`.',
        'Reuse the same `correlationId` from `request_input` when you call `wait_for_reply`. Once the durable wait returns active, stop the turn immediately and wait for the reply instead of calling `request_input` again.',
        'Do not ask the same pending human question twice before the durable wait resumes unless the question materially changes.',
        'Batch related questions into a single request rather than asking one question at a time.',
      ],
      requestMatchers: [],
    },
  ],

  // --- Internal platform tools ---

  manage_agents: [
    {
      toolName: 'manage_agents',
      capabilities: ['platform.agents'],
      disciplineGuidance: [
        'List agents once at the start of a task, then work with specific agent IDs. Do not re-list between each action.',
      ],
      requestMatchers: [],
    },
  ],
  manage_projects: [
    {
      toolName: 'manage_projects',
      capabilities: ['platform.projects'],
      disciplineGuidance: [
        'List projects once to orient, then operate on specific project IDs. Do not re-list after each update.',
      ],
      requestMatchers: [],
    },
  ],
  manage_tasks: [
    {
      toolName: 'manage_tasks',
      capabilities: ['platform.tasks'],
      disciplineGuidance: [
        'Read the task list once, make your changes, then move on. Do not re-read the task list after every update.',
      ],
      requestMatchers: [],
    },
  ],
  manage_schedules: [
    {
      toolName: 'manage_schedules',
      capabilities: ['platform.schedules'],
      disciplineGuidance: [
        'List schedules once to check current state. Do not re-list after each modification.',
      ],
      requestMatchers: [],
    },
  ],
  manage_skills: [
    {
      toolName: 'manage_skills',
      capabilities: ['platform.skills'],
      disciplineGuidance: [
        'Use `recommend_for_task` to find a relevant skill efficiently. Do not repeatedly list or search skills between each action.',
      ],
      requestMatchers: [],
    },
  ],
  manage_webhooks: [
    {
      toolName: 'manage_webhooks',
      capabilities: ['platform.webhooks'],
      disciplineGuidance: [
        'List webhooks once for current state. Do not re-list after each change.',
      ],
      requestMatchers: [],
    },
  ],
  manage_secrets: [
    {
      toolName: 'manage_secrets',
      capabilities: ['platform.secrets'],
      disciplineGuidance: [
        'Store secrets directly. Use the `check` action (not `list`) to verify if a credential already exists before requesting a new one.',
      ],
      requestMatchers: [],
    },
  ],
  manage_chatrooms: [
    {
      toolName: 'manage_chatrooms',
      capabilities: ['platform.chatrooms'],
      disciplineGuidance: [
        'List chatrooms once to orient, then operate on specific IDs. Do not re-list after each message or update.',
      ],
      requestMatchers: [],
    },
  ],
  manage_protocols: [
    {
      toolName: 'manage_protocols',
      capabilities: ['platform.protocols'],
      disciplineGuidance: [
        'Read the protocol definition once, then execute steps. Do not re-read the protocol between each step.',
      ],
      requestMatchers: [],
    },
  ],
  manage_platform: [
    {
      toolName: 'manage_platform',
      capabilities: ['platform.umbrella'],
      disciplineGuidance: [
        'Prefer the direct `manage_*` tools (manage_agents, manage_tasks, etc.) when they are enabled. Use `manage_platform` only as a fallback when the specific tool is not available.',
      ],
      requestMatchers: [],
    },
  ],
  spawn_subagent: [
    {
      toolName: 'spawn_subagent',
      capabilities: ['delegation.subagent'],
      disciplineGuidance: [
        'Use `waitForCompletion: true` (the default) or `wait`/`wait_all` actions to await results. Do not poll `status` in a loop.',
        'Batch related delegations — spawn multiple subagents at once if tasks are independent.',
        'For multi-step or cross-domain work, delegate to a subagent rather than attempting everything in one long tool chain.',
      ],
      requestMatchers: [],
    },
  ],
  delegate: [
    {
      toolName: 'delegate',
      capabilities: ['delegation.cli'],
      disciplineGuidance: [
        'Give the delegate a complete task description in one call. Do not send incremental instructions across multiple delegation calls.',
      ],
      requestMatchers: [],
    },
  ],
  manage_sessions: [
    {
      toolName: 'sessions_tool',
      capabilities: ['platform.sessions'],
      disciplineGuidance: [
        'Check session identity once at the start. Do not re-query session info between each action.',
      ],
      requestMatchers: [],
    },
  ],
  memory: [
    {
      toolName: 'memory_tool',
      capabilities: ['memory.search', 'memory.store'],
      disciplineGuidance: [
        'Search memory once with a good query, then use the results. Do not run multiple overlapping searches for the same topic.',
        'For stores and updates, write once with complete content. Do not read-back immediately after writing to confirm.',
      ],
      requestMatchers: [],
    },
  ],
  context_mgmt: [
    {
      toolName: 'context_status',
      capabilities: ['context.management'],
      disciplineGuidance: [
        'Check context status only when you suspect you are running low. Do not check after every tool call.',
      ],
      requestMatchers: [],
    },
  ],
  monitor: [
    {
      toolName: 'monitor_tool',
      capabilities: ['monitoring.watch'],
      disciplineGuidance: [
        'Prefer `wait_until`, `wait_for_http`, `wait_for_file`, or other `wait_for_*` shortcut actions — they create a durable wait that resumes your turn automatically. Avoid creating a watch with `create_watch` then polling `get_watch` in a loop.',
      ],
      requestMatchers: [],
    },
  ],
  image_gen: [
    {
      toolName: 'generate_image',
      capabilities: ['media.image_generation'],
      disciplineGuidance: [
        'Describe the image fully in one generation call. Do not generate multiple variations unless the user asks for options.',
      ],
      requestMatchers: [],
    },
  ],
  replicate: [
    {
      toolName: 'replicate',
      capabilities: ['media.replicate'],
      disciplineGuidance: [
        'Submit the job with complete parameters in one call. Use `wait: true` for synchronous completion. If running async, let the built-in polling handle it — do not add your own polling loop on top.',
      ],
      requestMatchers: [],
    },
  ],
  schedule_wake: [
    {
      toolName: 'schedule_wake',
      capabilities: ['runtime.schedule'],
      disciplineGuidance: [
        'Schedule the wake once with the correct time. Do not reschedule repeatedly to adjust by small increments.',
      ],
      requestMatchers: [],
    },
  ],
  mailbox: [
    {
      toolName: 'mailbox',
      capabilities: ['delivery.mailbox'],
      disciplineGuidance: [
        'Use `search_messages` for targeted retrieval instead of listing all messages. Do not poll the inbox in a loop waiting for replies.',
      ],
      requestMatchers: [],
    },
  ],
}

function dedupeStrings(values: string[]): string[] {
  return dedup(values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))
}

function normalizePlanningEntry(toolName: string, planning: ExtensionToolPlanning | null | undefined): ToolPlanningEntry | null {
  if (!planning) return null
  const capabilities = dedupeStrings(Array.isArray(planning.capabilities) ? planning.capabilities : [])
  const disciplineGuidance = dedupeStrings(Array.isArray(planning.disciplineGuidance) ? planning.disciplineGuidance : [])
  if (!capabilities.length && !disciplineGuidance.length) return null
  return {
    toolName,
    capabilities,
    disciplineGuidance,
  }
}

export function getEnabledToolPlanningView(enabledExtensions: string[]): ToolPlanningView {
  const displayToolIds = dedupeStrings(enabledExtensions.map((toolId) => canonicalizeExtensionId(toolId))).sort()
  const expandedExtensionIds = dedupeStrings(expandExtensionIds(enabledExtensions)).sort()
  const entries: ToolPlanningEntry[] = []

  for (const extensionId of expandedExtensionIds) {
    const coreEntries = CORE_TOOL_PLANNING[extensionId] || []
    for (const entry of coreEntries) {
      entries.push({
        toolName: entry.toolName,
        capabilities: [...entry.capabilities],
        disciplineGuidance: [...entry.disciplineGuidance],
      })
    }
  }

  for (const entry of [
    ...getNativeCapabilityTools(expandedExtensionIds),
    ...getExtensionManager().getTools(expandedExtensionIds),
  ]) {
    const planningEntry = normalizePlanningEntry(entry.tool.name, entry.tool.planning)
    if (planningEntry) entries.push(planningEntry)
  }

  const disciplineSet = new Set<string>()
  const capabilityToTools = new Map<string, Set<string>>()
  for (const entry of entries) {
    for (const line of entry.disciplineGuidance) disciplineSet.add(line)
    for (const capability of entry.capabilities) {
      const current = capabilityToTools.get(capability) || new Set<string>()
      current.add(entry.toolName)
      capabilityToTools.set(capability, current)
    }
  }

  return {
    displayToolIds,
    expandedExtensionIds,
    entries,
    disciplineGuidance: Array.from(disciplineSet),
    capabilityToTools: new Map(
      Array.from(capabilityToTools.entries()).map(([capability, toolNames]) => [capability, Array.from(toolNames)]),
    ),
  }
}

export function getToolsForCapability(enabledExtensions: string[], capability: string): string[] {
  return getEnabledToolPlanningView(enabledExtensions).capabilityToTools.get(capability) || []
}

export function getFirstToolForCapability(enabledExtensions: string[], capability: string): string | null {
  return getToolsForCapability(enabledExtensions, capability)[0] || null
}
