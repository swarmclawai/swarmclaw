'use client'

import { useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import type { SettingsSectionProps } from './types'

function buildWhatsAppContactId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `wa-contact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function UserPreferencesSection({ appSettings, patchSettings, inputClass }: SettingsSectionProps) {
  const agents = useAppStore((s) => s.agents)
  const sortedAgents = Object.values(agents).sort((a, b) => a.name.localeCompare(b.name))
  const whatsappApprovedContacts = Array.isArray(appSettings.whatsappApprovedContacts) ? appSettings.whatsappApprovedContacts : []
  const [nextWhatsAppLabel, setNextWhatsAppLabel] = useState('')
  const [nextWhatsAppPhone, setNextWhatsAppPhone] = useState('')

  const addWhatsAppContact = () => {
    const phone = nextWhatsAppPhone.trim()
    if (!phone) return
    const label = nextWhatsAppLabel.trim() || phone
    patchSettings({
      whatsappApprovedContacts: [
        ...whatsappApprovedContacts,
        { id: buildWhatsAppContactId(), label, phone },
      ],
    })
    setNextWhatsAppLabel('')
    setNextWhatsAppPhone('')
  }

  const removeWhatsAppContact = (id: string) => {
    patchSettings({
      whatsappApprovedContacts: whatsappApprovedContacts.filter((entry) => entry.id !== id),
    })
  }

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
          onClick={() => patchSettings({ suggestionsEnabled: !appSettings.suggestionsEnabled })}
          className={`relative w-9 h-5 rounded-full transition-colors ${appSettings.suggestionsEnabled ? 'bg-accent-bright' : 'bg-white/[0.10]'}`}
          style={{ fontFamily: 'inherit' }}
        >
          <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${appSettings.suggestionsEnabled ? 'translate-x-4' : ''}`} />
        </button>
      </div>

      {/* Default agent */}
      <div className="mt-6">
        <label className="text-[12px] font-600 text-text-2 block mb-1.5">Default Agent</label>
        <p className="text-[11px] text-text-3/60 mb-2">
          The agent that opens automatically when you start the app or use the default-agent shortcut.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
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
              <AgentAvatar seed={agent.avatarSeed || null} avatarUrl={agent.avatarUrl} name={agent.name} size={18} />
              {agent.name}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-6">
        <label className="text-[12px] font-600 text-text-2 block mb-1.5">WhatsApp Approved Users</label>
        <p className="text-[11px] text-text-3/60 mb-3">
          These numbers or JIDs are globally approved for WhatsApp DMs. They bypass per-connector pairing and are merged into WhatsApp allowlists.
        </p>

        {whatsappApprovedContacts.length > 0 ? (
          <div className="space-y-2 mb-3">
            {whatsappApprovedContacts.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center justify-between gap-3 rounded-[12px] border border-white/[0.06] bg-white/[0.03] px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="text-[12px] font-600 text-text truncate">{entry.label}</div>
                  <div className="text-[11px] text-text-3/70 truncate">{entry.phone}</div>
                </div>
                <button
                  type="button"
                  onClick={() => removeWhatsAppContact(entry.id)}
                  className="shrink-0 px-2.5 py-1.5 rounded-[8px] bg-white/[0.04] text-[11px] text-text-3 hover:text-text hover:bg-white/[0.08] transition-colors border-none cursor-pointer"
                  style={{ fontFamily: 'inherit' }}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="mb-3 rounded-[12px] border border-dashed border-white/[0.08] bg-white/[0.02] px-3 py-3 text-[11px] text-text-3/70">
            No globally approved WhatsApp users yet.
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto] gap-2">
          <input
            type="text"
            value={nextWhatsAppLabel}
            onChange={(e) => setNextWhatsAppLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addWhatsAppContact()
              }
            }}
            placeholder="Label (e.g. Family, Alice)"
            className={inputClass}
            style={{ fontFamily: 'inherit' }}
          />
          <input
            type="text"
            value={nextWhatsAppPhone}
            onChange={(e) => setNextWhatsAppPhone(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addWhatsAppContact()
              }
            }}
            placeholder="+15551234567 or 15551234567@s.whatsapp.net"
            className={inputClass}
            style={{ fontFamily: 'inherit' }}
          />
          <button
            type="button"
            onClick={addWhatsAppContact}
            disabled={!nextWhatsAppPhone.trim()}
            className="px-3 py-2 rounded-[10px] text-[12px] font-600 border border-white/[0.06] bg-white/[0.04] text-text transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer hover:bg-white/[0.08]"
            style={{ fontFamily: 'inherit' }}
          >
            Add User
          </button>
        </div>
      </div>
    </div>
  )
}
