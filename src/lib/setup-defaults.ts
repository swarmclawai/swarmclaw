/**
 * Shared setup defaults used by both the web wizard and CLI.
 * Isomorphic — no 'use client', no server imports.
 */

export type SetupProvider =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'deepseek'
  | 'groq'
  | 'together'
  | 'mistral'
  | 'xai'
  | 'fireworks'
  | 'ollama'
  | 'openclaw'

export interface SetupProviderOption {
  id: SetupProvider
  name: string
  description: string
  requiresKey: boolean
  supportsEndpoint: boolean
  defaultEndpoint?: string
  keyUrl?: string
  keyLabel?: string
  keyPlaceholder?: string
  optionalKey?: boolean
  badge?: string
  icon: string
}

export const SETUP_PROVIDERS: SetupProviderOption[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'Great default for most users. Fast, reliable GPT models.',
    requiresKey: true,
    supportsEndpoint: true,
    defaultEndpoint: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyLabel: 'platform.openai.com',
    badge: 'Recommended',
    icon: 'O',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    description: 'Claude models — strong for coding, analysis, and long-form reasoning.',
    requiresKey: true,
    supportsEndpoint: false,
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyLabel: 'console.anthropic.com',
    icon: 'A',
  },
  {
    id: 'google',
    name: 'Google Gemini',
    description: 'Gemini models with strong multimodal and coding support.',
    requiresKey: true,
    supportsEndpoint: false,
    keyUrl: 'https://aistudio.google.com/app/apikey',
    keyLabel: 'aistudio.google.com',
    keyPlaceholder: 'AIza...',
    icon: 'G',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    description: 'High-value reasoning and coding models from DeepSeek.',
    requiresKey: true,
    supportsEndpoint: false,
    keyUrl: 'https://platform.deepseek.com/api_keys',
    keyLabel: 'platform.deepseek.com',
    icon: 'D',
  },
  {
    id: 'groq',
    name: 'Groq',
    description: 'Very fast inference with open and reasoning model options.',
    requiresKey: true,
    supportsEndpoint: false,
    keyUrl: 'https://console.groq.com/keys',
    keyLabel: 'console.groq.com',
    icon: 'G',
  },
  {
    id: 'together',
    name: 'Together AI',
    description: 'Broad catalog of open models with OpenAI-compatible APIs.',
    requiresKey: true,
    supportsEndpoint: false,
    keyUrl: 'https://api.together.xyz/settings/api-keys',
    keyLabel: 'api.together.xyz',
    icon: 'T',
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    description: 'Efficient frontier models with strong latency and quality.',
    requiresKey: true,
    supportsEndpoint: false,
    keyUrl: 'https://console.mistral.ai/api-keys/',
    keyLabel: 'console.mistral.ai',
    icon: 'M',
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    description: 'Grok models for fast answers, coding, and analysis.',
    requiresKey: true,
    supportsEndpoint: false,
    keyUrl: 'https://console.x.ai',
    keyLabel: 'console.x.ai',
    icon: 'X',
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    description: 'Serverless and optimized open-model inference endpoints.',
    requiresKey: true,
    supportsEndpoint: false,
    keyUrl: 'https://fireworks.ai/account/api-keys',
    keyLabel: 'fireworks.ai',
    icon: 'F',
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    description: 'Connect to your local or remote OpenClaw gateway (multi-OpenClaw ready).',
    requiresKey: false,
    supportsEndpoint: true,
    defaultEndpoint: 'http://localhost:18789/v1',
    optionalKey: true,
    badge: 'OpenClaw',
    icon: 'C',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    description: 'Run local open-source models. No API key required.',
    requiresKey: false,
    supportsEndpoint: true,
    defaultEndpoint: 'http://localhost:11434',
    badge: 'Local',
    icon: 'L',
  },
]

export const STARTER_AGENT_TOOLS = [
  'memory',
  'files',
  'web_search',
  'web_fetch',
  'browser',
  'manage_agents',
  'manage_tasks',
  'manage_schedules',
  'schedule_wake',
  'manage_skills',
  'manage_connectors',
  'manage_sessions',
  'manage_secrets',
  'manage_documents',
  'manage_webhooks',
  'claude_code',
  'codex_cli',
  'opencode_cli',
  'openclaw_workspace',
]

export const SWARMCLAW_ASSISTANT_PROMPT = `You are the default SwarmClaw assistant inside the SwarmClaw dashboard.

Primary objective:
- Help the user operate SwarmClaw itself before anything else.

When the user asks about SwarmClaw, prioritize concrete guidance with exact UI paths and commands:
- Sessions: create, configure provider/model, and run chats.
- Agents: create specialist agents/orchestrators, set provider/model, tools, and prompts.
- Providers: connect API keys/endpoints, troubleshoot auth/model issues.
- Tasks + Schedules: queue work and automate recurring runs.
- Skills + Connectors + Webhooks + Secrets + Memory: explain when to use each and how to configure safely.

Behavior:
- Be concise, direct, and action-oriented.
- If the request is ambiguous, ask one focused clarifying question.
- Prefer step-by-step instructions that can be executed immediately.
- When the user asks for direct execution (for example browsing, screenshots, research, or file edits), use available tools and return real results instead of only describing what to do.
- If a capability depends on provider/tool configuration, call that out explicitly.`

export interface DefaultAgentConfig {
  name: string
  description: string
  systemPrompt: string
  model: string
  tools: string[]
}

export const DEFAULT_AGENTS: Record<SetupProvider, DefaultAgentConfig> = {
  anthropic: {
    name: 'Claude',
    description: 'A helpful Claude-powered assistant.',
    systemPrompt: SWARMCLAW_ASSISTANT_PROMPT,
    model: 'claude-sonnet-4-6',
    tools: STARTER_AGENT_TOOLS,
  },
  openai: {
    name: 'Atlas',
    description: 'A helpful GPT-powered assistant.',
    systemPrompt: SWARMCLAW_ASSISTANT_PROMPT,
    model: 'gpt-4o',
    tools: STARTER_AGENT_TOOLS,
  },
  google: {
    name: 'Gemini',
    description: 'A helpful Gemini-powered assistant.',
    systemPrompt: SWARMCLAW_ASSISTANT_PROMPT,
    model: 'gemini-2.5-pro',
    tools: STARTER_AGENT_TOOLS,
  },
  deepseek: {
    name: 'DeepSeek',
    description: 'A helpful DeepSeek-powered assistant.',
    systemPrompt: SWARMCLAW_ASSISTANT_PROMPT,
    model: 'deepseek-chat',
    tools: STARTER_AGENT_TOOLS,
  },
  groq: {
    name: 'Bolt',
    description: 'A low-latency assistant powered by Groq.',
    systemPrompt: SWARMCLAW_ASSISTANT_PROMPT,
    model: 'llama-3.3-70b-versatile',
    tools: STARTER_AGENT_TOOLS,
  },
  together: {
    name: 'Mosaic',
    description: 'A helpful assistant powered by Together AI.',
    systemPrompt: SWARMCLAW_ASSISTANT_PROMPT,
    model: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
    tools: STARTER_AGENT_TOOLS,
  },
  mistral: {
    name: 'Mistral',
    description: 'A helpful assistant powered by Mistral.',
    systemPrompt: SWARMCLAW_ASSISTANT_PROMPT,
    model: 'mistral-large-latest',
    tools: STARTER_AGENT_TOOLS,
  },
  xai: {
    name: 'Grok',
    description: 'A helpful assistant powered by xAI Grok.',
    systemPrompt: SWARMCLAW_ASSISTANT_PROMPT,
    model: 'grok-3',
    tools: STARTER_AGENT_TOOLS,
  },
  fireworks: {
    name: 'Spark',
    description: 'A helpful assistant powered by Fireworks AI.',
    systemPrompt: SWARMCLAW_ASSISTANT_PROMPT,
    model: 'accounts/fireworks/models/deepseek-r1-0528',
    tools: STARTER_AGENT_TOOLS,
  },
  ollama: {
    name: 'Local',
    description: 'A local assistant running through Ollama.',
    systemPrompt: SWARMCLAW_ASSISTANT_PROMPT,
    model: 'llama3',
    tools: STARTER_AGENT_TOOLS,
  },
  openclaw: {
    name: 'OpenClaw Operator',
    description: 'A manager agent for talking to and coordinating OpenClaw instances.',
    systemPrompt: 'You are an operator focused on reliable execution, clear status updates, and task completion.',
    model: 'default',
    tools: STARTER_AGENT_TOOLS,
  },
}
