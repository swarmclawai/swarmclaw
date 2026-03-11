export interface ToolDefinition {
  id: string
  label: string
  description: string
}

/** 
 * Standard dynamic tools. 
 * Many granular tools (read_file, write_file, etc.) are now unified under 'files'.
 */
export const AVAILABLE_TOOLS: ToolDefinition[] = [
  { id: 'shell', label: 'Shell', description: 'Execute commands in the working directory and manage background processes' },
  { id: 'files', label: 'Files', description: 'Complete file management: read, write, list, move, copy, delete, and send' },
  { id: 'edit_file', label: 'Edit File', description: 'Surgical search-and-replace within files' },
  { id: 'web', label: 'Web', description: 'Search the web via DuckDuckGo and fetch text from URLs' },
  { id: 'delegate', label: 'Delegate', description: 'Delegate complex tasks to specialized backends (Claude Code, Codex, OpenCode)' },
  { id: 'browser', label: 'Browser', description: 'Playwright — browse, scrape, interact with web pages' },
  { id: 'memory', label: 'Memory', description: 'Store and retrieve long-term memories across conversations' },
  { id: 'sandbox', label: 'Sandbox', description: 'Docker-preferred Node.js execution for custom JS/TS tasks, with host fallback when Docker is unavailable' },
  { id: 'create_document', label: 'Create Document', description: 'Render markdown to PDF, HTML, or image' },
  { id: 'create_spreadsheet', label: 'Create Spreadsheet', description: 'Create Excel or CSV files from structured data' },
  { id: 'http_request', label: 'HTTP Request', description: 'Make direct HTTP API calls without generating throwaway code' },
  { id: 'git', label: 'Git', description: 'Run structured git operations (status, commit, push, diff, etc.)' },
  { id: 'wallet', label: 'Wallet', description: 'Manage agent crypto wallet — check balance, send SOL, view transactions' },
  { id: 'monitor', label: 'Monitor', description: 'System observability: check resource usage, watch logs, and ping endpoints' },
  { id: 'plugin_creator', label: 'Plugin Creator', description: 'Design focused plugins for durable capabilities and recurring automations' },
  { id: 'sample_ui', label: 'Sample UI', description: 'Demonstration of dynamic UI injection into Sidebar and Chat Header' },
  { id: 'image_gen', label: 'Image Generation', description: 'Generate images from text prompts using OpenAI, Stability AI, Replicate, fal.ai, and more' },
  { id: 'email', label: 'Email', description: 'Send emails via SMTP with plain text and HTML support' },
  { id: 'calendar', label: 'Calendar', description: 'Manage Google Calendar or Outlook events — list, create, update, delete' },
  { id: 'replicate', label: 'Replicate', description: 'Run any AI model on Replicate — image generation, LLMs, audio, video, and more' },
  { id: 'google_workspace', label: 'Google Workspace', description: 'Run Google Workspace CLI (`gws`) commands for Drive, Docs, Sheets, Gmail, Calendar, Chat, and more' },
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
