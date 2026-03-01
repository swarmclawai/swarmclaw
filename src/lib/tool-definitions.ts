export interface ToolDefinition {
  id: string
  label: string
  description: string
}

export const AVAILABLE_TOOLS: ToolDefinition[] = [
  { id: 'shell', label: 'Shell', description: 'Execute commands in the working directory' },
  { id: 'files', label: 'Files', description: 'Read, write, list, move, copy, and send files' },
  { id: 'copy_file', label: 'Copy File', description: 'Copy files within the working directory' },
  { id: 'move_file', label: 'Move File', description: 'Move/rename files within the working directory' },
  { id: 'delete_file', label: 'Delete File', description: 'Delete files/directories (disabled by default)' },
  { id: 'edit_file', label: 'Edit File', description: 'Search-and-replace editing within files' },
  { id: 'process', label: 'Process', description: 'Monitor and control long-running shell commands' },
  { id: 'web_search', label: 'Web Search', description: 'Search the web via DuckDuckGo' },
  { id: 'web_fetch', label: 'Web Fetch', description: 'Fetch and extract text from URLs' },
  { id: 'claude_code', label: 'Claude Code', description: 'Delegate complex tasks to Claude Code CLI' },
  { id: 'codex_cli', label: 'Codex CLI', description: 'Delegate complex tasks to OpenAI Codex CLI' },
  { id: 'opencode_cli', label: 'OpenCode CLI', description: 'Delegate complex tasks to OpenCode CLI' },
  { id: 'browser', label: 'Browser', description: 'Playwright — browse, scrape, interact with web pages' },
  { id: 'memory', label: 'Memory', description: 'Store and retrieve long-term memories across conversations' },
  { id: 'sandbox', label: 'Sandbox', description: 'Run JS/TS/Python code in an isolated Deno sandbox' },
  { id: 'create_document', label: 'Create Document', description: 'Render markdown to PDF, HTML, or image' },
  { id: 'create_spreadsheet', label: 'Create Spreadsheet', description: 'Create Excel or CSV files from structured data' },
]

export const PLATFORM_TOOLS: ToolDefinition[] = [
  { id: 'manage_agents', label: 'Agents', description: 'Create, edit, and delete agents' },
  { id: 'manage_tasks', label: 'Tasks', description: 'Create, edit, and delete tasks' },
  { id: 'manage_schedules', label: 'Schedules', description: 'Create, edit, and delete schedules' },
  { id: 'manage_skills', label: 'Skills', description: 'Create, edit, and delete skills' },
  { id: 'manage_documents', label: 'Documents', description: 'Upload, search, and delete indexed documents' },
  { id: 'manage_webhooks', label: 'Webhooks', description: 'Register webhooks that trigger agent workflows' },
  { id: 'manage_connectors', label: 'Connectors', description: 'Create, edit, and delete connectors' },
  { id: 'manage_sessions', label: 'Chats', description: 'List chats, send messages, and spawn agent work' },
  { id: 'manage_secrets', label: 'Secrets', description: 'Store and retrieve encrypted service secrets' },
]

export const ALL_TOOLS: ToolDefinition[] = [...AVAILABLE_TOOLS, ...PLATFORM_TOOLS]

/** Flat id→label lookup for display */
export const TOOL_LABELS: Record<string, string> = Object.fromEntries(
  ALL_TOOLS.map((t) => [t.id, t.label]),
)
