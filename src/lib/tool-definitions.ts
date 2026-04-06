export interface ToolDefinition {
  id: string
  label: string
  description: string
  /**
   * The builtin extension ID that backs this tool.
   * If the extension is disabled, the tool should be greyed out in the UI.
   * Omit for tools that are always available (core tools without a separate extension).
   */
  extensionId?: string
}

/**
 * Standard dynamic tools.
 * Many granular tools (read_file, write_file, etc.) are now unified under 'files'.
 */
export const AVAILABLE_TOOLS: ToolDefinition[] = [
  { id: 'shell', label: 'Shell', description: 'Execute commands in the working directory and manage background processes' },
  { id: 'execute', label: 'Execute', description: 'Run sandboxed bash scripts with just-bash, with optional host execution when explicitly enabled' },
  { id: 'files', label: 'Files', description: 'Complete file management: read, write, list, move, copy, delete, and send' },
  { id: 'edit_file', label: 'Edit File', description: 'Surgical search-and-replace within files' },
  { id: 'web', label: 'Web', description: 'Search the web, fetch content, and make HTTP API calls' },
  { id: 'delegate', label: 'Delegate', description: 'Delegate complex tasks to specialized backends (Claude Code, Codex, OpenCode)' },
  { id: 'browser', label: 'Browser', description: 'Playwright — browse, scrape, interact with web pages' },
  { id: 'memory', label: 'Memory', description: 'Store and retrieve long-term memories across conversations' },
  { id: 'monitor', label: 'Monitor', description: 'Durable watch jobs: monitor files, endpoints, tasks, and resume agents on triggers' },
  { id: 'extension_creator', label: 'Extension Creator', description: 'Design focused extensions for durable capabilities and recurring automations' },
  { id: 'image_gen', label: 'Image Generation', description: 'Generate images from text prompts using OpenAI, Stability AI, Replicate, fal.ai, and more', extensionId: 'image_gen' },
  { id: 'email', label: 'Email', description: 'Send emails via SMTP with plain text and HTML support', extensionId: 'email' },
  { id: 'replicate', label: 'Replicate', description: 'Run any AI model on Replicate — image generation, LLMs, audio, video, and more', extensionId: 'replicate' },
  { id: 'google_workspace', label: 'Google Workspace', description: 'Run Google Workspace CLI (`gws`) commands for Drive, Docs, Sheets, Gmail, Calendar, Chat, and more', extensionId: 'google_workspace' },
  { id: 'swarmfeed', label: 'SwarmFeed', description: 'Post, reply, like, repost, and browse the SwarmFeed social network (auto-enabled when SwarmFeed is on)' },
  { id: 'swarmdock', label: 'SwarmDock', description: 'Browse tasks and inspect marketplace status/profile on SwarmDock (auto-enabled when SwarmDock is on)' },
]

/**
 * Platform capability tools.
 * Granular CRUD tools are now unified under 'manage_platform'.
 */
export const PLATFORM_TOOLS: ToolDefinition[] = [
  { id: 'manage_platform', label: 'Platform', description: 'Unified management of agents, projects, tasks, schedules, skills, documents, and secrets' },
  { id: 'manage_projects', label: 'Projects', description: 'Manage durable project context: objectives, priorities, heartbeat plans, credential needs, and linked resources' },
  { id: 'manage_connectors', label: 'Connectors', description: 'Manage chat platform bridges and send outbound messages' },
  { id: 'manage_chatrooms', label: 'Chatrooms', description: 'Manage SwarmClaw routing rules and multi-agent chatrooms' },
  { id: 'delegate_to_agent', label: 'Assign Agent', description: 'Delegate a task to another specific agent' },
  { id: 'schedule_wake', label: 'Reminders', description: 'Schedule a proactive wake event in the current chat' },
]

export const ALL_TOOLS: ToolDefinition[] = [...AVAILABLE_TOOLS, ...PLATFORM_TOOLS]

/** Flat id→label lookup for display */
export const TOOL_LABELS: Record<string, string> = Object.fromEntries(
  ALL_TOOLS.map((t) => [t.id, t.label]),
)
