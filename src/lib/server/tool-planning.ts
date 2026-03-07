import type { PluginToolPlanning } from '@/types'
import { getPluginManager } from './plugins'
import { canonicalizePluginId, expandPluginIds } from './tool-aliases'

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
  requestMatchers: NonNullable<PluginToolPlanning['requestMatchers']>
}

export interface ToolPlanningView {
  displayToolIds: string[]
  expandedPluginIds: string[]
  entries: ToolPlanningEntry[]
  disciplineGuidance: string[]
  capabilityToTools: Map<string, string[]>
}

const CORE_TOOL_PLANNING: Record<string, ToolPlanningEntry[]> = {
  files: [
    {
      toolName: 'files',
      capabilities: ['artifact.files'],
      disciplineGuidance: [
        'For `files`, include an explicit action whenever possible. Common patterns: `{"action":"list","dirPath":"."}`, `{"action":"read","filePath":"path/to/file.md"}`, and `{"action":"write","files":[{"path":"path/to/file.md","content":"..."}]}`.',
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
      ],
      requestMatchers: [
        {
          capability: TOOL_CAPABILITY.researchSearch,
          patterns: ['research', 'look up', 'find out', 'search for', 'compare', 'latest', 'news', 'headline', 'current event', 'recent update', "what's new", 'what happened'],
          forbidLiteralUrl: true,
        },
      ],
    },
    {
      toolName: 'web_fetch',
      capabilities: [TOOL_CAPABILITY.researchFetch],
      disciplineGuidance: [
        'For `web_fetch`, use `{"url":"https://..."}` to read a specific page or article after you know the URL.',
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
      ],
      requestMatchers: [
        {
          capability: TOOL_CAPABILITY.deliveryMessage,
          patterns: ['send', 'share', 'deliver', 'message'],
        },
        {
          capability: TOOL_CAPABILITY.deliveryMedia,
          patterns: ['screenshot', 'screen shot', 'snapshot', 'image', 'photo', 'file', 'pdf', 'attachment'],
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
      ],
      requestMatchers: [],
    },
  ],
  ask_human: [
    {
      toolName: 'ask_human',
      capabilities: ['human.input'],
      disciplineGuidance: [
        'For `ask_human`, when a workflow needs a code, approval, or out-of-band value from a person, do not guess or keep re-submitting blank forms. Use `{"action":"request_input","question":"..."}` and, for durable pauses, `{"action":"wait_for_reply","correlationId":"..."}`.',
      ],
      requestMatchers: [],
    },
  ],
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim())))
}

function normalizePlanningEntry(toolName: string, planning: PluginToolPlanning | null | undefined): ToolPlanningEntry | null {
  if (!planning) return null
  const capabilities = dedupeStrings(Array.isArray(planning.capabilities) ? planning.capabilities : [])
  const disciplineGuidance = dedupeStrings(Array.isArray(planning.disciplineGuidance) ? planning.disciplineGuidance : [])
  const requestMatchers = Array.isArray(planning.requestMatchers)
    ? planning.requestMatchers
        .map((matcher) => ({
          capability: typeof matcher?.capability === 'string' ? matcher.capability.trim() : '',
          patterns: dedupeStrings(Array.isArray(matcher?.patterns) ? matcher.patterns : []),
          requireLiteralUrl: matcher?.requireLiteralUrl === true,
          forbidLiteralUrl: matcher?.forbidLiteralUrl === true,
        }))
        .filter((matcher) => matcher.capability || matcher.patterns.length > 0)
    : []
  if (!capabilities.length && !disciplineGuidance.length && !requestMatchers.length) return null
  return {
    toolName,
    capabilities,
    disciplineGuidance,
    requestMatchers,
  }
}

export function getEnabledToolPlanningView(enabledPlugins: string[]): ToolPlanningView {
  const displayToolIds = dedupeStrings(enabledPlugins.map((toolId) => canonicalizePluginId(toolId))).sort()
  const expandedPluginIds = dedupeStrings(expandPluginIds(enabledPlugins)).sort()
  const entries: ToolPlanningEntry[] = []

  for (const pluginId of expandedPluginIds) {
    const coreEntries = CORE_TOOL_PLANNING[pluginId] || []
    for (const entry of coreEntries) {
      entries.push({
        toolName: entry.toolName,
        capabilities: [...entry.capabilities],
        disciplineGuidance: [...entry.disciplineGuidance],
        requestMatchers: [...entry.requestMatchers],
      })
    }
  }

  for (const entry of getPluginManager().getTools(expandedPluginIds)) {
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
    expandedPluginIds,
    entries,
    disciplineGuidance: Array.from(disciplineSet),
    capabilityToTools: new Map(
      Array.from(capabilityToTools.entries()).map(([capability, toolNames]) => [capability, Array.from(toolNames)]),
    ),
  }
}

export function getToolsForCapability(enabledPlugins: string[], capability: string): string[] {
  return getEnabledToolPlanningView(enabledPlugins).capabilityToTools.get(capability) || []
}

export function getFirstToolForCapability(enabledPlugins: string[], capability: string): string | null {
  return getToolsForCapability(enabledPlugins, capability)[0] || null
}

export function matchToolCapabilitiesForMessage(
  enabledPlugins: string[],
  message: string,
): Map<string, string[]> {
  const text = String(message || '').toLowerCase()
  const hasLiteralUrl = /https?:\/\/[^\s<>"')]+/i.test(message)
  const matches = new Map<string, Set<string>>()

  for (const entry of getEnabledToolPlanningView(enabledPlugins).entries) {
    for (const matcher of entry.requestMatchers) {
      const patterns = Array.isArray(matcher.patterns) ? matcher.patterns : []
      if (matcher.requireLiteralUrl === true && !hasLiteralUrl) continue
      if (matcher.forbidLiteralUrl === true && hasLiteralUrl) continue
      if (!patterns.length) continue
      const matched = patterns.some((pattern) => text.includes(pattern.toLowerCase()))
      if (!matched) continue
      const capability = matcher.capability || entry.capabilities[0] || ''
      if (!capability) continue
      const current = matches.get(capability) || new Set<string>()
      current.add(entry.toolName)
      matches.set(capability, current)
    }
  }

  return new Map(Array.from(matches.entries()).map(([capability, toolNames]) => [capability, Array.from(toolNames)]))
}
