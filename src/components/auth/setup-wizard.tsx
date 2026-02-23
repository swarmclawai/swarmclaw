'use client'

import { useState } from 'react'
import { api } from '@/lib/api-client'
import type { ProviderType, Credential } from '@/types'

type WizardProvider = 'anthropic' | 'openai' | 'ollama'

interface SetupWizardProps {
  onComplete: () => void
}

const PROVIDERS: { id: WizardProvider; name: string; description: string; requiresKey: boolean; keyUrl?: string; keyLabel?: string }[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    description: 'Claude models — great for coding, analysis, and creative tasks.',
    requiresKey: true,
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyLabel: 'console.anthropic.com',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'GPT models — versatile and widely supported.',
    requiresKey: true,
    keyUrl: 'https://platform.openai.com/api-keys',
    keyLabel: 'platform.openai.com',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    description: 'Run open-source models locally. No API key needed.',
    requiresKey: false,
  },
]

const DEFAULT_AGENTS: Record<WizardProvider, { name: string; description: string; systemPrompt: string; model: string }> = {
  anthropic: {
    name: 'Assistant',
    description: 'A helpful general-purpose assistant powered by Claude.',
    systemPrompt: 'You are a helpful, knowledgeable assistant. Be concise and accurate.',
    model: 'claude-sonnet-4-6',
  },
  openai: {
    name: 'Assistant',
    description: 'A helpful general-purpose assistant powered by GPT.',
    systemPrompt: 'You are a helpful, knowledgeable assistant. Be concise and accurate.',
    model: 'gpt-4o',
  },
  ollama: {
    name: 'Assistant',
    description: 'A helpful general-purpose assistant running locally.',
    systemPrompt: 'You are a helpful, knowledgeable assistant. Be concise and accurate.',
    model: 'llama3.1',
  },
}

function SparkleIcon() {
  return (
    <div className="flex justify-center mb-6">
      <div className="relative w-12 h-12">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-primary mb-6"
          style={{ animation: 'sparkle-spin 8s linear infinite' }}>
          <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3 1.07.56 2 1.56 2 3a2.5 2.5 0 0 1-2.5 2.5z" />
          <path d="M12 2c0 2.22-1 3.5-2 5.5 2.5 1 5.5 5 5.5 9.5a5.5 5.5 0 1 1-11 0c0-1.55.64-2.31 1.54-3.5a14.95 14.95 0 0 1 1.05-3c-.15.14-.35.15-.45.15-1.5 0-2.39-1.39-2.39-2.65 0-2.12 1.56-4.49 1.86-4.99L12 2z" />
        </svg>
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
          className={`h-1.5 rounded-full transition-all duration-300 ${i === current
            ? 'w-6 bg-primary'
            : i < current
              ? 'w-1.5 bg-primary/50'
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
      Skip setup
    </button>
  )
}

export function SetupWizard({ onComplete }: SetupWizardProps) {
  const [step, setStep] = useState(0)
  const [provider, setProvider] = useState<WizardProvider | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [credentialId, setCredentialId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Step 3 agent fields
  const [agentName, setAgentName] = useState('')
  const [agentDescription, setAgentDescription] = useState('')
  const [agentPrompt, setAgentPrompt] = useState('')
  const [agentModel, setAgentModel] = useState('')

  const totalSteps = provider === 'ollama' ? 2 : 3
  const displayStep = provider === 'ollama' && step === 2 ? 1 : step

  const skip = async () => {
    try {
      await api('PUT', '/settings', { setupCompleted: true })
    } catch { /* proceed anyway */ }
    onComplete()
  }

  const selectProvider = (p: WizardProvider) => {
    setProvider(p)
    const defaults = DEFAULT_AGENTS[p]
    setAgentName(defaults.name)
    setAgentDescription(defaults.description)
    setAgentPrompt(defaults.systemPrompt)
    setAgentModel(defaults.model)

    if (p === 'ollama') {
      // Skip the API key step
      setStep(2)
    } else {
      setStep(1)
    }
  }

  const saveApiKey = async () => {
    if (!apiKey.trim() || !provider) return
    setSaving(true)
    setError('')
    try {
      const cred = await api<Credential>('POST', '/credentials', {
        provider,
        name: `${provider} key`,
        apiKey: apiKey.trim(),
      })
      setCredentialId(cred.id)
      setStep(2)
    } catch (e: any) {
      setError(e?.message || 'Failed to save API key')
    } finally {
      setSaving(false)
    }
  }

  const createAgent = async () => {
    if (!provider || !agentName.trim()) return
    setSaving(true)
    setError('')
    try {
      await api('POST', '/agents', {
        name: agentName.trim(),
        description: agentDescription.trim(),
        systemPrompt: agentPrompt.trim(),
        provider: provider as ProviderType,
        model: agentModel,
        credentialId: credentialId,
      })
      await api('PUT', '/settings', { setupCompleted: true })
      onComplete()
    } catch (e: any) {
      setError(e?.message || 'Failed to create agent')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="h-full flex flex-col items-center justify-center px-8 bg-bg relative overflow-hidden">
      {/* Atmospheric gradient mesh */}
      <div className="absolute inset-0 pointer-events-none">
        <div
          className="absolute top-[30%] left-[50%] -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px]"
          style={{
            background: 'radial-gradient(ellipse at center, rgba(var(--primary-rgb),0.1) 0%, transparent 70%)',
            animation: 'glow-pulse 6s ease-in-out infinite',
          }}
        />
        <div
          className="absolute bottom-[20%] left-[30%] w-[300px] h-[300px]"
          style={{
            background: 'radial-gradient(circle, rgba(236,72,153,0.03) 0%, transparent 70%)',
            animation: 'glow-pulse 8s ease-in-out infinite 2s',
          }}
        />
      </div>

      <div
        className="relative max-w-[480px] w-full text-center"
        style={{ animation: 'fade-in 0.6s cubic-bezier(0.16, 1, 0.3, 1)' }}
      >
        <SparkleIcon />
        <StepDots current={displayStep} total={totalSteps} />

        {/* Step 1: Choose Provider */}
        {step === 0 && (
          <>
            <h1 className="font-display text-[36px] font-800 leading-[1.05] tracking-[-0.04em] mb-3">
              Choose a Provider
            </h1>
            <p className="text-[15px] text-text-2 mb-8">
              Pick the LLM provider you want to start with. You can add more later.
            </p>

            <div className="flex flex-col gap-3">
              {PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => selectProvider(p.id)}
                  className="w-full px-5 py-4 rounded-[14px] border border-white/[0.08] bg-surface text-left
                    cursor-pointer hover:border-primary/30 hover:bg-surface-hover transition-all duration-200
                    flex items-start gap-4"
                >
                  <div className="w-10 h-10 rounded-[10px] bg-white/[0.04] border border-white/[0.06] flex items-center justify-center shrink-0 mt-0.5">
                    <span className="text-[16px] font-display font-700 text-primary">
                      {p.id === 'anthropic' ? 'A' : p.id === 'openai' ? 'O' : 'L'}
                    </span>
                  </div>
                  <div>
                    <div className="text-[15px] font-display font-600 text-text mb-1">{p.name}</div>
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

            <SkipLink onClick={skip} />
          </>
        )}

        {/* Step 2: Enter API Key */}
        {step === 1 && provider && provider !== 'ollama' && (
          <>
            <h1 className="font-display text-[36px] font-800 leading-[1.05] tracking-[-0.04em] mb-3">
              Add Your API Key
            </h1>
            <p className="text-[15px] text-text-2 mb-2">
              Enter your {PROVIDERS.find((p) => p.id === provider)?.name} API key. It will be stored encrypted on this server.
            </p>
            {(() => {
              const p = PROVIDERS.find((p) => p.id === provider)
              return p?.keyUrl ? (
                <p className="text-[13px] text-text-3 mb-8">
                  Get one at{' '}
                  <a
                    href={p.keyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    {p.keyLabel}
                  </a>
                </p>
              ) : null
            })()}

            <div className="flex flex-col items-center gap-4">
              <input
                type="password"
                value={apiKey}
                onChange={(e) => { setApiKey(e.target.value); setError('') }}
                placeholder="sk-..."
                autoFocus
                autoComplete="off"
                className="w-full max-w-[360px] px-6 py-4 rounded-[16px] border border-white/[0.08] bg-surface
                  text-text text-[15px] font-mono outline-none
                  transition-all duration-200 placeholder:text-text-3/40
                  focus:border-primary/30 focus:shadow-[0_0_30px_rgba(var(--primary-rgb),0.1)]"
              />

              {error && <p className="text-[13px] text-red-400">{error}</p>}

              <div className="flex items-center gap-3">
                <button
                  onClick={() => { setStep(0); setApiKey(''); setError('') }}
                  className="px-6 py-3.5 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[14px]
                    font-display font-500 cursor-pointer hover:bg-white/[0.03] transition-all duration-200"
                >
                  Back
                </button>
                <button
                  onClick={saveApiKey}
                  disabled={!apiKey.trim() || saving}
                  className="px-10 py-3.5 rounded-[14px] border-none bg-primary text-primary-foreground text-[15px] font-display font-600
                    cursor-pointer hover:brightness-110 active:scale-[0.97] transition-all duration-200
                    shadow-[0_6px_28px_rgba(var(--primary-rgb),0.3)] disabled:opacity-30"
                >
                  {saving ? 'Saving...' : 'Save & Continue'}
                </button>
              </div>
            </div>

            <SkipLink onClick={skip} />
          </>
        )}

        {/* Step 3: Create Agent */}
        {step === 2 && provider && (
          <>
            <h1 className="font-display text-[36px] font-800 leading-[1.05] tracking-[-0.04em] mb-3">
              Create Your First Agent
            </h1>
            <p className="text-[15px] text-text-2 mb-8">
              Set up an agent to start chatting. You can customize it or accept the defaults.
            </p>

            <div className="flex flex-col gap-3 text-left">
              <div>
                <label className="block text-[12px] text-text-3 font-500 mb-1.5 ml-1">Name</label>
                <input
                  type="text"
                  value={agentName}
                  onChange={(e) => setAgentName(e.target.value)}
                  className="w-full px-4 py-3 rounded-[12px] border border-white/[0.08] bg-surface
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
                  className="w-full px-4 py-3 rounded-[12px] border border-white/[0.08] bg-surface
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
                  className="w-full px-4 py-3 rounded-[12px] border border-white/[0.08] bg-surface
                     text-[14px] outline-none transition-all duration-200 resize-none
                    focus:border-primary/30 focus:shadow-[0_0_30px_rgba(var(--primary-rgb),0.1)]"
                />
              </div>
              <div>
                <label className="block text-[12px] text-text-3 font-500 mb-1.5 ml-1">Model</label>
                <input
                  type="text"
                  value={agentModel}
                  onChange={(e) => setAgentModel(e.target.value)}
                  className="w-full px-4 py-3 rounded-[12px] border border-white/[0.08] bg-surface
                     text-[14px] font-mono outline-none transition-all duration-200
                    focus:border-primary/30 focus:shadow-[0_0_30px_rgba(var(--primary-rgb),0.1)]"
                />
              </div>
            </div>

            {error && <p className="mt-3 text-[13px] text-red-400">{error}</p>}

            <div className="flex items-center justify-center gap-3 mt-6">
              <button
                onClick={() => { setStep(provider === 'ollama' ? 0 : 1); setError('') }}
                className="px-6 py-3.5 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[14px]
                  font-display font-500 cursor-pointer hover:bg-white/[0.03] transition-all duration-200"
              >
                Back
              </button>
              <button
                onClick={createAgent}
                disabled={!agentName.trim() || saving}
                className="px-10 py-3.5 rounded-[14px] border-none bg-primary text-primary-foreground text-[15px] font-display font-600
                    cursor-pointer hover:brightness-110 active:scale-[0.97] transition-all duration-200
                    shadow-[0_6px_28px_rgba(var(--primary-rgb),0.3)] disabled:opacity-30"
              >
                {saving ? 'Creating...' : 'Create Agent'}
              </button>
            </div>

            <SkipLink onClick={skip} />
          </>
        )}
      </div>
    </div>
  )
}
