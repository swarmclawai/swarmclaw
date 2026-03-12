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
  | 'custom'

export interface SetupProviderOption {
  id: SetupProvider
  name: string
  description: string
  requiresKey: boolean
  supportsEndpoint: boolean
  /** @deprecated No longer used — each provider type can only be configured once */
  allowMultiple?: boolean
  defaultEndpoint?: string
  keyUrl?: string
  keyLabel?: string
  keyPlaceholder?: string
  optionalKey?: boolean
  badge?: string
  icon: string
  modelLibraryUrl?: string
  cloudEndpoint?: string
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
    modelLibraryUrl: 'https://platform.openai.com/docs/models',
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    description: 'Deploy or connect official-only local and remote OpenClaw gateways, then map starter agents across your swarm by role, tag, or use case.',
    requiresKey: false,
    supportsEndpoint: true,
    allowMultiple: true,
    defaultEndpoint: 'http://localhost:18789/v1',
    optionalKey: true,
    badge: 'First-Tier',
    icon: 'C',
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
    modelLibraryUrl: 'https://docs.anthropic.com/en/docs/about-claude/models',
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
    modelLibraryUrl: 'https://ai.google.dev/gemini-api/docs/models',
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
    modelLibraryUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
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
    modelLibraryUrl: 'https://console.groq.com/docs/models',
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
    modelLibraryUrl: 'https://docs.together.ai/docs/chat-models',
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
    modelLibraryUrl: 'https://docs.mistral.ai/getting-started/models/models_overview/',
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
    modelLibraryUrl: 'https://docs.x.ai/docs/models',
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
    modelLibraryUrl: 'https://fireworks.ai/models',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    description: 'Run local open-source models or connect to Ollama Cloud.',
    requiresKey: false,
    supportsEndpoint: true,
    allowMultiple: true,
    defaultEndpoint: 'http://localhost:11434',
    optionalKey: true,
    badge: 'Local + Cloud',
    icon: 'L',
    modelLibraryUrl: 'https://ollama.com/library',
    cloudEndpoint: 'https://api.ollama.com',
  },
  {
    id: 'custom',
    name: 'Custom Provider',
    description: 'Any OpenAI-compatible API endpoint (OpenRouter, LM Studio, vLLM, etc.).',
    requiresKey: false,
    supportsEndpoint: true,
    allowMultiple: true,
    optionalKey: true,
    icon: '+',
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

const PERSONAL_ASSISTANT_PROMPT = `You are a personal AI copilot inside SwarmClaw.

Primary objective:
- Help the user make progress on whatever matters to them, whether that is research, planning, writing, building, organizing life admin, or running a business.

Behavior:
- Start from the user's intent, not from the tooling.
- Turn vague goals into concrete next steps.
- When useful, suggest tasks, schedules, or specialist agents, but do not force control-plane workflow on the user.
- Stay concise, practical, and execution-oriented.`

const RESEARCH_PROMPT = `You are a research copilot inside SwarmClaw.

Primary objective:
- Gather facts, compare options, summarize findings, and keep the user's work organized.

Behavior:
- Clarify the research question when needed.
- Prefer structured findings, tradeoffs, and source-backed summaries.
- Capture useful outputs in files or tasks when that helps the user continue.`

const BUILDER_PROMPT = `You are a builder agent inside SwarmClaw.

Primary objective:
- Help the user design, implement, debug, and ship software or technical projects.

Behavior:
- Move from goal to concrete implementation steps quickly.
- Use code, files, browser, and task tooling when helpful.
- Surface blockers, assumptions, and verification clearly.`

const REVIEWER_PROMPT = `You are a reviewer agent inside SwarmClaw.

Primary objective:
- Review plans, code, documents, and outputs for quality, correctness, and risk.

Behavior:
- Focus first on bugs, regressions, gaps, and unclear assumptions.
- Be direct and specific.
- Offer concrete follow-up actions when you find issues.`

const WRITER_PROMPT = `You are a writing copilot inside SwarmClaw.

Primary objective:
- Help the user draft, refine, and structure written work for clarity and impact.

Behavior:
- Adapt tone, format, and level of detail to the user's context.
- Suggest outlines, drafts, revisions, and packaging for different channels.
- Keep momentum high and avoid generic filler.`

const EDITOR_PROMPT = `You are an editor inside SwarmClaw.

Primary objective:
- Improve drafts for clarity, structure, tone, and quality.

Behavior:
- Tighten weak writing, call out inconsistencies, and preserve the intended voice.
- Give concise, high-signal edits and rationale.
- Flag missing evidence or unclear claims when relevant.`

const OPERATOR_PROMPT = `You are an operations-focused SwarmClaw operator.

Primary objective:
- Keep work moving across agents, tasks, schedules, and approvals without losing sight of the user's real goals.

Behavior:
- Monitor progress, surface bottlenecks, and delegate when appropriate.
- Be explicit about what is blocked, what is running, and what should happen next.
- Treat the control plane as a means to an end, not the end itself.`

export type OnboardingPath = 'quick' | 'intent' | 'manual'

export interface OnboardingPathOption {
  id: OnboardingPath
  title: string
  description: string
  detail: string
  badge?: string
}

export const ONBOARDING_PATHS: OnboardingPathOption[] = [
  {
    id: 'quick',
    title: 'Quick Start',
    description: 'Provider first, one starter kit, fastest path into chat.',
    detail: 'Best when you already know which provider you want and want to get moving quickly.',
    badge: 'Fastest',
  },
  {
    id: 'manual',
    title: 'Custom Setup',
    description: 'Configure providers first and choose whether to start blank or from a template.',
    detail: 'Best for advanced users who want control over the initial setup and agent mix.',
  },
]

export interface StarterKitAgentTemplate {
  id: string
  name: string
  description: string
  systemPrompt: string
  tools: string[]
  capabilities?: string[]
  recommendedProviders?: SetupProvider[]
  platformAssignScope?: 'self' | 'all'
}

export interface StarterKit {
  id: string
  name: string
  description: string
  detail: string
  badge?: string
  recommendedFor?: OnboardingPath[]
  agents: StarterKitAgentTemplate[]
}

const PERSONAL_AGENT_TOOLS = [
  'memory',
  'files',
  'web_search',
  'web_fetch',
  'browser',
  'manage_tasks',
  'manage_schedules',
  'manage_documents',
]

const RESEARCH_AGENT_TOOLS = [
  'memory',
  'files',
  'web_search',
  'web_fetch',
  'browser',
  'manage_tasks',
  'manage_documents',
]

const BUILDER_AGENT_TOOLS = [
  'memory',
  'files',
  'web_search',
  'web_fetch',
  'browser',
  'manage_tasks',
  'claude_code',
  'codex_cli',
  'opencode_cli',
]

const OPERATOR_AGENT_TOOLS = STARTER_AGENT_TOOLS
const OPENCLAW_AGENT_TOOLS = [
  'memory',
  'files',
  'web_search',
  'web_fetch',
  'browser',
  'manage_tasks',
  'manage_schedules',
  'manage_sessions',
  'openclaw_workspace',
]

export const STARTER_KITS: StarterKit[] = [
  {
    id: 'personal_assistant',
    name: 'Personal Assistant',
    description: 'One flexible agent for open-ended work.',
    detail: 'A strong default for general planning, research, writing, and day-to-day execution.',
    badge: 'Recommended',
    recommendedFor: ['quick', 'intent'],
    agents: [
      {
        id: 'sidekick',
        name: 'Sidekick',
        description: 'A versatile assistant for everyday work, planning, and follow-through.',
        systemPrompt: PERSONAL_ASSISTANT_PROMPT,
        tools: PERSONAL_AGENT_TOOLS,
        capabilities: ['planning', 'research', 'writing', 'coordination'],
      },
    ],
  },
  {
    id: 'research_copilot',
    name: 'Research Copilot',
    description: 'A focused setup for investigation and synthesis.',
    detail: 'Useful for market scans, comparisons, technical investigation, and source-backed summaries.',
    recommendedFor: ['intent', 'manual'],
    agents: [
      {
        id: 'researcher',
        name: 'Researcher',
        description: 'Collects facts, compares options, and produces structured findings.',
        systemPrompt: RESEARCH_PROMPT,
        tools: RESEARCH_AGENT_TOOLS,
        capabilities: ['research', 'analysis', 'summarization'],
      },
    ],
  },
  {
    id: 'builder_studio',
    name: 'Builder Studio',
    description: 'Start with a builder and a reviewer.',
    detail: 'Good for coding, prototyping, product work, and technical iteration.',
    recommendedFor: ['intent', 'manual'],
    agents: [
      {
        id: 'builder',
        name: 'Builder',
        description: 'Implements ideas, ships changes, and drives technical execution.',
        systemPrompt: BUILDER_PROMPT,
        tools: BUILDER_AGENT_TOOLS,
        capabilities: ['coding', 'debugging', 'implementation'],
        recommendedProviders: ['anthropic', 'openai', 'google', 'openclaw', 'ollama'],
      },
      {
        id: 'reviewer',
        name: 'Reviewer',
        description: 'Reviews plans and outputs for bugs, regressions, and quality gaps.',
        systemPrompt: REVIEWER_PROMPT,
        tools: RESEARCH_AGENT_TOOLS,
        capabilities: ['review', 'testing', 'risk assessment'],
        recommendedProviders: ['anthropic', 'openai', 'google', 'openclaw'],
      },
    ],
  },
  {
    id: 'content_studio',
    name: 'Content Studio',
    description: 'A writer and editor working together.',
    detail: 'Useful for blogs, marketing copy, docs, newsletters, and publishing workflows.',
    recommendedFor: ['intent', 'manual'],
    agents: [
      {
        id: 'writer',
        name: 'Writer',
        description: 'Drafts content, outlines, and messaging in the user’s preferred style.',
        systemPrompt: WRITER_PROMPT,
        tools: PERSONAL_AGENT_TOOLS,
        capabilities: ['writing', 'messaging', 'structuring'],
      },
      {
        id: 'editor',
        name: 'Editor',
        description: 'Improves structure, tone, and quality before publishing.',
        systemPrompt: EDITOR_PROMPT,
        tools: RESEARCH_AGENT_TOOLS,
        capabilities: ['editing', 'quality control', 'review'],
      },
    ],
  },
  {
    id: 'operator_swarm',
    name: 'Operator Swarm',
    description: 'A coordination-heavy setup for multi-agent work.',
    detail: 'Closest to the current SwarmClaw operator workflow, with an orchestrator plus an execution agent.',
    recommendedFor: ['manual'],
    agents: [
      {
        id: 'operator',
        name: 'Operator',
        description: 'Coordinates tasks, delegates work, and keeps the workspace moving.',
        systemPrompt: OPERATOR_PROMPT,
        tools: OPERATOR_AGENT_TOOLS,
        capabilities: ['coordination', 'delegation', 'operations'],
        platformAssignScope: 'all',
        recommendedProviders: ['openclaw', 'anthropic', 'openai'],
      },
      {
        id: 'maker',
        name: 'Maker',
        description: 'Executes focused work items assigned by the user or other agents.',
        systemPrompt: BUILDER_PROMPT,
        tools: BUILDER_AGENT_TOOLS,
        capabilities: ['execution', 'implementation', 'research'],
      },
    ],
  },
  {
    id: 'openclaw_fleet',
    name: 'OpenClaw Fleet',
    description: 'An OpenClaw-first starter setup for local or remote gateways.',
    detail: 'Designed for users who want multiple OpenClaw-backed agents right away, with official-only local deploy, single-VPS, and private-tailnet defaults built into setup.',
    recommendedFor: ['manual'],
    badge: 'OpenClaw',
    agents: [
      {
        id: 'openclaw_operator',
        name: 'OpenClaw Operator',
        description: 'Coordinates OpenClaw-backed execution and keeps distributed agents aligned.',
        systemPrompt: OPERATOR_PROMPT,
        tools: OPERATOR_AGENT_TOOLS,
        capabilities: ['coordination', 'delegation', 'openclaw'],
        platformAssignScope: 'all',
        recommendedProviders: ['openclaw'],
      },
      {
        id: 'openclaw_builder',
        name: 'Remote Builder',
        description: 'A build-focused OpenClaw agent for implementation work on a chosen gateway.',
        systemPrompt: BUILDER_PROMPT,
        tools: OPENCLAW_AGENT_TOOLS,
        capabilities: ['coding', 'implementation', 'openclaw'],
        recommendedProviders: ['openclaw'],
      },
      {
        id: 'openclaw_researcher',
        name: 'Remote Researcher',
        description: 'A research-focused OpenClaw agent for browser and knowledge work on a chosen gateway.',
        systemPrompt: RESEARCH_PROMPT,
        tools: OPENCLAW_AGENT_TOOLS,
        capabilities: ['research', 'analysis', 'openclaw'],
        recommendedProviders: ['openclaw'],
      },
    ],
  },
  {
    id: 'blank_workspace',
    name: 'Blank Workspace',
    description: 'Finish setup without starter agents.',
    detail: 'Use this if you want to land in the app first and create providers, agents, and workflows yourself.',
    recommendedFor: ['manual'],
    badge: 'Blank',
    agents: [],
  },
]

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
    model: '',
    tools: STARTER_AGENT_TOOLS,
  },
  custom: {
    name: 'Custom Agent',
    description: 'An assistant powered by a custom OpenAI-compatible provider.',
    systemPrompt: SWARMCLAW_ASSISTANT_PROMPT,
    model: '',
    tools: STARTER_AGENT_TOOLS,
  },
}

export function getDefaultModelForProvider(provider: SetupProvider): string {
  return DEFAULT_AGENTS[provider].model
}
