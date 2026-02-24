'use client'

import { useMemo, useState } from 'react'
import { api } from '@/lib/api-client'
import { useAppStore } from '@/stores/use-app-store'
import type { ProviderType, Credential } from '@/types'

type WizardProvider =
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
type CheckState = 'idle' | 'checking' | 'ok' | 'error'

interface WizardProviderOption {
  id: WizardProvider
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

interface ProviderCheckResponse {
  ok: boolean
  message: string
  normalizedEndpoint?: string
  recommendedModel?: string
}

interface SetupDoctorCheck {
  id: string
  label: string
  status: 'pass' | 'warn' | 'fail'
  detail: string
  required?: boolean
}

interface SetupDoctorResponse {
  ok: boolean
  summary: string
  checks: SetupDoctorCheck[]
  actions?: string[]
}

interface SetupWizardProps {
  onComplete: () => void
}

const STARTER_AGENT_TOOLS = [
  'memory',
  'files',
  'web_search',
  'web_fetch',
  'browser',
  'manage_agents',
  'manage_tasks',
  'manage_schedules',
  'manage_skills',
  'manage_connectors',
  'manage_sessions',
  'manage_secrets',
  'manage_documents',
  'manage_webhooks',
  'claude_code',
  'codex_cli',
  'opencode_cli',
]

const SWARMCLAW_ASSISTANT_PROMPT = `You are the default SwarmClaw assistant inside the SwarmClaw dashboard.

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

const PROVIDERS: WizardProviderOption[] = [
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

const DEFAULT_AGENTS: Record<WizardProvider, { name: string; description: string; systemPrompt: string; model: string; tools: string[] }> = {
  anthropic: {
    name: 'Assistant',
    description: 'A helpful Claude-powered assistant.',
    systemPrompt: SWARMCLAW_ASSISTANT_PROMPT,
    model: 'claude-sonnet-4-6',
    tools: STARTER_AGENT_TOOLS,
  },
  openai: {
    name: 'Assistant',
    description: 'A helpful GPT-powered assistant.',
    systemPrompt: SWARMCLAW_ASSISTANT_PROMPT,
    model: 'gpt-4o',
    tools: STARTER_AGENT_TOOLS,
  },
  google: {
    name: 'Assistant',
    description: 'A helpful Gemini-powered assistant.',
    systemPrompt: SWARMCLAW_ASSISTANT_PROMPT,
    model: 'gemini-2.5-pro',
    tools: STARTER_AGENT_TOOLS,
  },
  deepseek: {
    name: 'Assistant',
    description: 'A helpful DeepSeek-powered assistant.',
    systemPrompt: SWARMCLAW_ASSISTANT_PROMPT,
    model: 'deepseek-chat',
    tools: STARTER_AGENT_TOOLS,
  },
  groq: {
    name: 'Assistant',
    description: 'A low-latency assistant powered by Groq.',
    systemPrompt: SWARMCLAW_ASSISTANT_PROMPT,
    model: 'llama-3.3-70b-versatile',
    tools: STARTER_AGENT_TOOLS,
  },
  together: {
    name: 'Assistant',
    description: 'A helpful assistant powered by Together AI.',
    systemPrompt: SWARMCLAW_ASSISTANT_PROMPT,
    model: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
    tools: STARTER_AGENT_TOOLS,
  },
  mistral: {
    name: 'Assistant',
    description: 'A helpful assistant powered by Mistral.',
    systemPrompt: SWARMCLAW_ASSISTANT_PROMPT,
    model: 'mistral-large-latest',
    tools: STARTER_AGENT_TOOLS,
  },
  xai: {
    name: 'Assistant',
    description: 'A helpful assistant powered by xAI Grok.',
    systemPrompt: SWARMCLAW_ASSISTANT_PROMPT,
    model: 'grok-3',
    tools: STARTER_AGENT_TOOLS,
  },
  fireworks: {
    name: 'Assistant',
    description: 'A helpful assistant powered by Fireworks AI.',
    systemPrompt: SWARMCLAW_ASSISTANT_PROMPT,
    model: 'accounts/fireworks/models/deepseek-r1-0528',
    tools: STARTER_AGENT_TOOLS,
  },
  ollama: {
    name: 'Assistant',
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

function SparkleIcon() {
  return (
    <div className="flex justify-center mb-6">
      <div className="relative w-12 h-12">
        <svg
          width="48"
          height="48"
          viewBox="0 0 48 48"
          fill="none"
          className="text-accent-bright"
          style={{ animation: 'sparkle-spin 8s linear infinite' }}
        >
          <path
            d="M24 4L27.5 18.5L42 24L27.5 29.5L24 44L20.5 29.5L6 24L20.5 18.5L24 4Z"
            fill="currentColor"
            opacity="0.9"
          />
        </svg>
        <div className="absolute inset-0 blur-xl bg-accent-bright/20" />
      </div>
    </div>
  )
}

function StepDots({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center justify-center gap-2 mb-8">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={`h-1.5 rounded-full transition-all duration-300 ${
            i === current
              ? 'w-6 bg-accent-bright'
              : i < current
                ? 'w-1.5 bg-accent-bright/50'
                : 'w-1.5 bg-white/10'
          }`}
        />
      ))}
    </div>
  )
}

function SkipLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="mt-8 text-[13px] text-text-3 hover:text-text-2 transition-colors cursor-pointer bg-transparent border-none"
    >
      Skip setup for now
    </button>
  )
}

function ProviderBadge({ label }: { label?: string }) {
  if (!label) return null
  return (
    <span className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-accent-bright/15 text-accent-bright text-[10px] uppercase tracking-[0.08em] font-600">
      {label}
    </span>
  )
}

export function SetupWizard({ onComplete }: SetupWizardProps) {
  const [step, setStep] = useState(0)
  const [provider, setProvider] = useState<WizardProvider | null>(null)
  const [endpoint, setEndpoint] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [credentialId, setCredentialId] = useState<string | null>(null)
  const [checkState, setCheckState] = useState<CheckState>('idle')
  const [checkMessage, setCheckMessage] = useState('')
  const [doctorState, setDoctorState] = useState<'idle' | 'checking' | 'done' | 'error'>('idle')
  const [doctorError, setDoctorError] = useState('')
  const [doctorReport, setDoctorReport] = useState<SetupDoctorResponse | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const [agentName, setAgentName] = useState('')
  const [agentDescription, setAgentDescription] = useState('')
  const [agentPrompt, setAgentPrompt] = useState('')
  const [agentModel, setAgentModel] = useState('')

  const selectedProvider = useMemo(
    () => PROVIDERS.find((p) => p.id === provider) || null,
    [provider],
  )
  const totalSteps = 3
  const requiresKey = selectedProvider?.requiresKey || false
  const supportsEndpoint = selectedProvider?.supportsEndpoint || false
  const keyIsOptional = selectedProvider?.optionalKey || false
  const requiresVerifiedConnection = provider === 'openclaw'

  const skip = async () => {
    try {
      await api('PUT', '/settings', { setupCompleted: true })
    } catch {
      // Continue anyway.
    }
    onComplete()
  }

  const selectProvider = (next: WizardProvider) => {
    const defaults = DEFAULT_AGENTS[next]
    const meta = PROVIDERS.find((p) => p.id === next)

    setProvider(next)
    setEndpoint(meta?.defaultEndpoint || '')
    setApiKey('')
    setCredentialId(null)
    setCheckState('idle')
    setCheckMessage('')
    setError('')

    setAgentName(defaults.name)
    setAgentDescription(defaults.description)
    setAgentPrompt(defaults.systemPrompt)
    setAgentModel(defaults.model)

    setStep(1)
  }

  const runConnectionCheck = async (): Promise<boolean> => {
    if (!provider || !selectedProvider) return false
    if (requiresKey && !apiKey.trim()) {
      setCheckState('error')
      setCheckMessage('Please paste your API key first.')
      return false
    }

    setCheckState('checking')
    setCheckMessage('')
    setError('')
    try {
      const result = await api<ProviderCheckResponse>('POST', '/setup/check-provider', {
        provider,
        apiKey: apiKey.trim() || undefined,
        endpoint: supportsEndpoint ? endpoint.trim() || undefined : undefined,
        model: agentModel.trim() || undefined,
      })

      if (result.normalizedEndpoint && supportsEndpoint) {
        setEndpoint(result.normalizedEndpoint)
      }
      if (result.recommendedModel && provider) {
        const currentModel = agentModel.trim()
        const defaultModel = DEFAULT_AGENTS[provider].model
        if (!currentModel || currentModel === defaultModel) {
          setAgentModel(result.recommendedModel)
        }
      }
      setCheckState(result.ok ? 'ok' : 'error')
      setCheckMessage(result.message || (result.ok ? 'Connected successfully.' : 'Connection failed.'))
      return !!result.ok
    } catch (err: any) {
      setCheckState('error')
      setCheckMessage(err?.message || 'Connection check failed.')
      return false
    }
  }

  const runSetupDoctor = async () => {
    setDoctorState('checking')
    setDoctorError('')
    try {
      const report = await api<SetupDoctorResponse>('GET', '/setup/doctor')
      setDoctorReport(report)
      setDoctorState('done')
    } catch (err: any) {
      setDoctorState('error')
      setDoctorReport(null)
      setDoctorError(err?.message || 'Failed to run setup diagnostics.')
    }
  }

  const saveProviderAndContinue = async () => {
    if (!provider || !selectedProvider) return
    if (requiresKey && !apiKey.trim()) {
      setError('This provider requires an API key.')
      return
    }

    setSaving(true)
    setError('')
    try {
      if (requiresVerifiedConnection && checkState !== 'ok') {
        const ok = await runConnectionCheck()
        if (!ok) {
          setError('OpenClaw must pass connection verification before continuing.')
          return
        }
      }

      let nextCredentialId = credentialId
      const shouldSaveCredential = !!apiKey.trim() && (requiresKey || keyIsOptional)

      if (shouldSaveCredential && !nextCredentialId) {
        const cred = await api<Credential>('POST', '/credentials', {
          provider,
          name: `${selectedProvider.name} key`,
          apiKey: apiKey.trim(),
        })
        nextCredentialId = cred.id
      }

      setCredentialId(nextCredentialId || null)
      setStep(2)
    } catch (err: any) {
      setError(err?.message || 'Failed to save provider setup.')
    } finally {
      setSaving(false)
    }
  }

  const createStarterAgent = async () => {
    if (!provider || !agentName.trim()) return
    if (requiresVerifiedConnection && checkState !== 'ok') {
      setError('OpenClaw connection is not verified. Go back and run the connection check.')
      setStep(1)
      return
    }
    setSaving(true)
    setError('')
    try {
      const payload: Record<string, unknown> = {
        name: agentName.trim(),
        description: agentDescription.trim(),
        systemPrompt: agentPrompt.trim(),
        provider: provider as ProviderType,
        model: agentModel.trim() || DEFAULT_AGENTS[provider].model,
        credentialId: credentialId || null,
        tools: DEFAULT_AGENTS[provider].tools,
      }

      if (supportsEndpoint && endpoint.trim()) {
        payload.apiEndpoint = endpoint.trim()
      }

      const agents = await api<Record<string, { id: string }>>('GET', '/agents')
      const canReuseDefault =
        !!agents.default
        && Object.keys(agents).length === 1
        && agentName.trim().toLowerCase() === 'assistant'

      const agentId = canReuseDefault
        ? 'default'
        : (await api<{ id: string }>('POST', '/agents', payload)).id

      if (canReuseDefault) {
        await api('PUT', '/agents/default', payload)
      }

      const appState = useAppStore.getState()
      const currentUser = appState.currentUser
      if (currentUser && agentId) {
        const sessionMap = await api<Record<string, { id: string; name: string; user: string }>>('GET', '/sessions')
        const existingMain = Object.values(sessionMap).find((s) => s.name === '__main__' && s.user === currentUser)
        const mainId = existingMain?.id || `main-${currentUser}`
        const selectedModel = (payload.model as string) || DEFAULT_AGENTS[provider].model
        const selectedEndpoint = supportsEndpoint ? (payload.apiEndpoint as string | undefined) || null : null
        const selectedTools = Array.isArray(payload.tools) ? payload.tools as string[] : DEFAULT_AGENTS[provider].tools

        if (!existingMain) {
          await api('POST', '/sessions', {
            id: mainId,
            name: '__main__',
            user: currentUser,
            agentId,
            provider,
            model: selectedModel,
            credentialId: credentialId || null,
            apiEndpoint: selectedEndpoint,
            tools: selectedTools,
            heartbeatEnabled: true,
          })
        }

        await api('PUT', `/sessions/${mainId}`, {
          agentId,
          provider,
          model: selectedModel,
          credentialId: credentialId || null,
          apiEndpoint: selectedEndpoint,
          tools: selectedTools,
          heartbeatEnabled: true,
        })

        await appState.loadSessions()
        appState.setCurrentSession(mainId)
      }
      await api('PUT', '/settings', { setupCompleted: true })
      onComplete()
    } catch (err: any) {
      setError(err?.message || 'Failed to create starter assistant.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="h-full flex flex-col items-center justify-center px-8 bg-bg relative overflow-hidden">
      <div className="absolute inset-0 pointer-events-none">
        <div
          className="absolute top-[30%] left-[50%] -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px]"
          style={{
            background: 'radial-gradient(ellipse at center, rgba(99,102,241,0.06) 0%, transparent 70%)',
            animation: 'glow-pulse 6s ease-in-out infinite',
          }}
        />
      </div>

      <div
        className="relative max-w-[520px] w-full text-center"
        style={{ animation: 'fade-in 0.6s cubic-bezier(0.16, 1, 0.3, 1)' }}
      >
        <SparkleIcon />
        <StepDots current={step} total={totalSteps} />

        {step === 0 && (
          <>
            <h1 className="font-display text-[36px] font-800 leading-[1.05] tracking-[-0.04em] mb-3">
              2-Minute Setup
            </h1>
            <p className="text-[15px] text-text-2 mb-2">
              No coding required. Pick a provider, paste a key if needed, and start chatting.
            </p>
            <p className="text-[13px] text-text-3 mb-8">
              You can change providers, models, and agent settings anytime later.
            </p>

            <div className="flex flex-col gap-3 max-h-[44vh] overflow-y-auto pr-1">
              {PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => selectProvider(p.id)}
                  className="w-full px-5 py-4 rounded-[14px] border border-white/[0.08] bg-surface text-left
                    cursor-pointer hover:border-accent-bright/30 hover:bg-surface-hover transition-all duration-200
                    flex items-start gap-4"
                >
                  <div className="w-10 h-10 rounded-[10px] bg-white/[0.04] border border-white/[0.06] flex items-center justify-center shrink-0 mt-0.5">
                    <span className="text-[16px] font-display font-700 text-accent-bright">
                      {p.icon}
                    </span>
                  </div>
                  <div>
                    <div className="text-[15px] font-display font-600 text-text mb-1">
                      {p.name}
                      <ProviderBadge label={p.badge} />
                    </div>
                    <div className="text-[13px] text-text-3 leading-relaxed">{p.description}</div>
                    {!p.requiresKey && (
                      <div className="mt-1.5 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400 text-[11px] font-500">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                        No API key required
                      </div>
                    )}
                  </div>
                </button>
              ))}
            </div>

            <div className="mt-4 text-left">
              <button
                onClick={runSetupDoctor}
                disabled={doctorState === 'checking'}
                className="w-full px-4 py-3 rounded-[12px] border border-white/[0.08] bg-white/[0.02] text-[13px] text-text-2
                  cursor-pointer hover:bg-white/[0.05] transition-all duration-200 disabled:opacity-40"
              >
                {doctorState === 'checking' ? 'Running System Check...' : 'Run System Check'}
              </button>

              {doctorState === 'error' && doctorError && (
                <p className="mt-2 text-[12px] text-red-300">{doctorError}</p>
              )}

              {doctorReport && doctorState === 'done' && (
                <div className="mt-3 p-3 rounded-[12px] border border-white/[0.08] bg-surface">
                  <div className={`text-[12px] font-600 ${doctorReport.ok ? 'text-emerald-300' : 'text-amber-300'}`}>
                    {doctorReport.summary}
                  </div>
                  {doctorReport.checks.filter((c) => c.status !== 'pass').slice(0, 3).map((check) => (
                    <div key={check.id} className="mt-1 text-[11px] text-text-3">
                      - {check.label}: {check.detail}
                    </div>
                  ))}
                  {!!doctorReport.actions?.length && (
                    <div className="mt-2 text-[11px] text-text-3/80">
                      Next: {doctorReport.actions.slice(0, 2).join(' ')}
                    </div>
                  )}
                </div>
              )}
            </div>

            <SkipLink onClick={skip} />
          </>
        )}

        {step === 1 && provider && selectedProvider && (
          <>
            <h1 className="font-display text-[36px] font-800 leading-[1.05] tracking-[-0.04em] mb-3">
              Connect {selectedProvider.name}
            </h1>
            <p className="text-[15px] text-text-2 mb-2">
              Add only what is needed for this provider, then check connection.
            </p>
            <p className="text-[13px] text-text-3 mb-7">
              {requiresVerifiedConnection
                ? 'OpenClaw must pass connection check before you can continue.'
                : 'You can keep going even if the check fails and fix details later.'}
            </p>

            <div className="flex flex-col gap-3 text-left mb-4">
              {supportsEndpoint && (
                <div>
                  <label className="block text-[12px] text-text-3 font-500 mb-1.5 ml-1">
                    Endpoint
                  </label>
                  <input
                    type="text"
                    value={endpoint}
                    onChange={(e) => { setEndpoint(e.target.value); setCheckState('idle'); setCheckMessage('') }}
                    placeholder={selectedProvider.defaultEndpoint || ''}
                    className="w-full px-4 py-3 rounded-[12px] border border-white/[0.08] bg-surface
                      text-text text-[14px] font-mono outline-none transition-all duration-200
                      focus:border-accent-bright/30 focus:shadow-[0_0_30px_rgba(99,102,241,0.1)]"
                  />
                </div>
              )}

              {(requiresKey || keyIsOptional) && (
                <div>
                  <label className="block text-[12px] text-text-3 font-500 mb-1.5 ml-1">
                    {keyIsOptional ? 'Token (optional)' : 'API key'}
                  </label>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => { setApiKey(e.target.value); setCheckState('idle'); setCheckMessage(''); setError('') }}
                    placeholder={selectedProvider.keyPlaceholder || (provider === 'openclaw' ? 'Paste OpenClaw bearer token' : 'sk-...')}
                    className="w-full px-4 py-3 rounded-[12px] border border-white/[0.08] bg-surface
                      text-text text-[14px] font-mono outline-none transition-all duration-200
                      focus:border-accent-bright/30 focus:shadow-[0_0_30px_rgba(99,102,241,0.1)]"
                  />
                  {selectedProvider.keyUrl && (
                    <p className="text-[11px] text-text-3 mt-1.5">
                      Get one at{' '}
                      <a
                        href={selectedProvider.keyUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-accent-bright hover:underline"
                      >
                        {selectedProvider.keyLabel}
                      </a>
                    </p>
                  )}
                </div>
              )}
            </div>

            {checkState !== 'idle' && (
              <div
                className={`mb-4 px-3 py-2 rounded-[10px] text-[12px] border ${
                  checkState === 'ok'
                    ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
                    : checkState === 'checking'
                      ? 'bg-white/[0.03] border-white/[0.08] text-text-2'
                      : 'bg-red-500/10 border-red-500/25 text-red-300'
                }`}
              >
                {checkState === 'checking' ? 'Checking connection...' : checkMessage}
              </div>
            )}

            {error && <p className="mb-4 text-[13px] text-red-400">{error}</p>}

            <div className="flex items-center justify-center gap-3">
              <button
                onClick={() => { setStep(0); setError('') }}
                className="px-6 py-3.5 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[14px]
                  font-display font-500 cursor-pointer hover:bg-white/[0.03] transition-all duration-200"
              >
                Back
              </button>
              <button
                onClick={runConnectionCheck}
                disabled={checkState === 'checking' || saving}
                className="px-6 py-3.5 rounded-[14px] border border-white/[0.08] bg-white/[0.03] text-text text-[14px]
                  font-display font-600 cursor-pointer hover:bg-white/[0.06] transition-all duration-200 disabled:opacity-40"
              >
                {checkState === 'checking' ? 'Checking...' : 'Check Connection'}
              </button>
              <button
                onClick={saveProviderAndContinue}
                disabled={(requiresKey && !apiKey.trim()) || saving}
                className="px-8 py-3.5 rounded-[14px] border-none bg-[#6366F1] text-white text-[15px] font-display font-600
                  cursor-pointer hover:brightness-110 active:scale-[0.97] transition-all duration-200
                  shadow-[0_6px_28px_rgba(99,102,241,0.3)] disabled:opacity-30"
              >
                {saving
                  ? 'Saving...'
                  : requiresVerifiedConnection
                    ? 'Verify & Continue'
                    : 'Save & Continue'}
              </button>
            </div>

            <SkipLink onClick={skip} />
          </>
        )}

        {step === 2 && provider && selectedProvider && (
          <>
            <h1 className="font-display text-[36px] font-800 leading-[1.05] tracking-[-0.04em] mb-3">
              You&apos;re Ready
            </h1>
            <p className="text-[15px] text-text-2 mb-7">
              We&apos;ll create a starter assistant so you can begin immediately.
            </p>

            <div className="mb-5 p-4 rounded-[14px] border border-white/[0.08] bg-surface text-left">
              <div className="text-[12px] uppercase tracking-[0.08em] text-text-3 mb-2">Setup Summary</div>
              <div className="text-[14px] text-text mb-1">Provider: {selectedProvider.name}</div>
              {supportsEndpoint && endpoint.trim() && (
                <div className="text-[12px] font-mono text-text-3 break-all">Endpoint: {endpoint.trim()}</div>
              )}
              {checkState === 'ok' && (
                <div className="mt-2 text-[12px] text-emerald-300">{checkMessage}</div>
              )}
              {checkState === 'error' && (
                <div className="mt-2 text-[12px] text-amber-300">Connection was not verified. You can still continue.</div>
              )}
            </div>

            <details className="mb-6 text-left rounded-[14px] border border-white/[0.08] bg-surface px-4 py-3">
              <summary className="cursor-pointer text-[13px] text-text-2 font-600">
                Advanced agent settings (optional)
              </summary>
              <div className="mt-3 space-y-3">
                <div>
                  <label className="block text-[12px] text-text-3 font-500 mb-1.5 ml-1">Name</label>
                  <input
                    type="text"
                    value={agentName}
                    onChange={(e) => setAgentName(e.target.value)}
                    className="w-full px-4 py-3 rounded-[12px] border border-white/[0.08] bg-bg
                      text-text text-[14px] outline-none transition-all duration-200
                      focus:border-accent-bright/30 focus:shadow-[0_0_30px_rgba(99,102,241,0.1)]"
                  />
                </div>
                <div>
                  <label className="block text-[12px] text-text-3 font-500 mb-1.5 ml-1">Description</label>
                  <input
                    type="text"
                    value={agentDescription}
                    onChange={(e) => setAgentDescription(e.target.value)}
                    className="w-full px-4 py-3 rounded-[12px] border border-white/[0.08] bg-bg
                      text-text text-[14px] outline-none transition-all duration-200
                      focus:border-accent-bright/30 focus:shadow-[0_0_30px_rgba(99,102,241,0.1)]"
                  />
                </div>
                <div>
                  <label className="block text-[12px] text-text-3 font-500 mb-1.5 ml-1">System Prompt</label>
                  <textarea
                    value={agentPrompt}
                    onChange={(e) => setAgentPrompt(e.target.value)}
                    rows={3}
                    className="w-full px-4 py-3 rounded-[12px] border border-white/[0.08] bg-bg
                      text-text text-[14px] outline-none transition-all duration-200 resize-none
                      focus:border-accent-bright/30 focus:shadow-[0_0_30px_rgba(99,102,241,0.1)]"
                  />
                </div>
                <div>
                  <label className="block text-[12px] text-text-3 font-500 mb-1.5 ml-1">Model</label>
                  <input
                    type="text"
                    value={agentModel}
                    onChange={(e) => setAgentModel(e.target.value)}
                    className="w-full px-4 py-3 rounded-[12px] border border-white/[0.08] bg-bg
                      text-text text-[14px] font-mono outline-none transition-all duration-200
                      focus:border-accent-bright/30 focus:shadow-[0_0_30px_rgba(99,102,241,0.1)]"
                  />
                </div>
              </div>
            </details>

            {error && <p className="mb-4 text-[13px] text-red-400">{error}</p>}

            <div className="flex items-center justify-center gap-3">
              <button
                onClick={() => { setStep(1); setError('') }}
                className="px-6 py-3.5 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[14px]
                  font-display font-500 cursor-pointer hover:bg-white/[0.03] transition-all duration-200"
              >
                Back
              </button>
              <button
                onClick={createStarterAgent}
                disabled={!agentName.trim() || saving}
                className="px-10 py-3.5 rounded-[14px] border-none bg-[#6366F1] text-white text-[15px] font-display font-600
                  cursor-pointer hover:brightness-110 active:scale-[0.97] transition-all duration-200
                  shadow-[0_6px_28px_rgba(99,102,241,0.3)] disabled:opacity-30"
              >
                {saving ? 'Creating...' : 'Create Starter Assistant'}
              </button>
            </div>

            <SkipLink onClick={skip} />
          </>
        )}
      </div>
    </div>
  )
}
