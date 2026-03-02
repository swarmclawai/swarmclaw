'use client'

import { useAppStore } from '@/stores/use-app-store'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import type { SettingsSectionProps } from './types'

export function UserPreferencesSection({ appSettings, patchSettings, inputClass }: SettingsSectionProps) {
  const agents = useAppStore((s) => s.agents)
  const sortedAgents = Object.values(agents).sort((a, b) => a.name.localeCompare(b.name))

  return (
    <div className="mb-10">
      <h3 className="font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
        User Preferences
      </h3>
      <p className="text-[12px] text-text-3 mb-5">
        Global instructions injected into ALL agent system prompts. Define your style, rules, and preferences.
      </p>
      <textarea
        value={appSettings.userPrompt || ''}
        onChange={(e) => patchSettings({ userPrompt: e.target.value })}
        placeholder="e.g. Always respond concisely. Use TypeScript over JavaScript. Prefer functional patterns. My timezone is PST."
        rows={4}
        className={`${inputClass} resize-y min-h-[100px]`}
        style={{ fontFamily: 'inherit' }}
      />

      {/* Suggested replies toggle */}
      <div className="mt-6 flex items-center justify-between">
        <div>
          <label className="text-[12px] font-600 text-text-2 block">Suggested Replies</label>
          <p className="text-[11px] text-text-3/60 mt-0.5">
            Show follow-up suggestions after each agent response.
          </p>
        </div>
        <button
          type="button"
          onClick={() => patchSettings({ suggestionsEnabled: appSettings.suggestionsEnabled === false })}
          className={`relative w-9 h-5 rounded-full transition-colors ${appSettings.suggestionsEnabled !== false ? 'bg-accent-bright' : 'bg-white/[0.10]'}`}
          style={{ fontFamily: 'inherit' }}
        >
          <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${appSettings.suggestionsEnabled !== false ? 'translate-x-4' : ''}`} />
        </button>
      </div>

      {/* Default agent */}
      <div className="mt-6">
        <label className="text-[12px] font-600 text-text-2 block mb-1.5">Default Agent</label>
        <p className="text-[11px] text-text-3/60 mb-2">
          The agent that opens automatically when you start the app or click Main Chat.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => patchSettings({ defaultAgentId: null })}
            className={`flex items-center gap-2 px-3 py-2 rounded-[10px] text-[12px] font-600 cursor-pointer transition-all border
              ${!appSettings.defaultAgentId
                ? 'bg-white/[0.06] border-accent-bright/30 text-text'
                : 'bg-transparent border-white/[0.06] text-text-3 hover:bg-white/[0.03]'}`}
            style={{ fontFamily: 'inherit' }}
          >
            Auto (first agent)
          </button>
          {sortedAgents.map((agent) => (
            <button
              key={agent.id}
              onClick={() => patchSettings({ defaultAgentId: agent.id })}
              className={`flex items-center gap-2 px-3 py-2 rounded-[10px] text-[12px] font-600 cursor-pointer transition-all border
                ${appSettings.defaultAgentId === agent.id
                  ? 'bg-white/[0.06] border-accent-bright/30 text-text'
                  : 'bg-transparent border-white/[0.06] text-text-3 hover:bg-white/[0.03]'}`}
              style={{ fontFamily: 'inherit' }}
            >
              <AgentAvatar seed={agent.avatarSeed || null} name={agent.name} size={18} />
              {agent.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
