'use client'

import { useState, useEffect } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import { api } from '@/lib/api-client'
import type { Connector, ConnectorPlatform } from '@/types'

const PLATFORMS: {
  id: ConnectorPlatform
  label: string
  color: string
  icon: string
  setupSteps: string[]
  tokenLabel: string
  tokenHelp: string
  configFields: { key: string; label: string; placeholder: string; help?: string }[]
}[] = [
  {
    id: 'discord',
    label: 'Discord',
    color: '#5865F2',
    icon: 'DI',
    setupSteps: [
      'Go to discord.com/developers/applications and create a new app',
      'Under "Bot", click "Reset Token" and copy it',
      'Enable MESSAGE CONTENT intent under "Privileged Gateway Intents"',
      'Under "OAuth2 > URL Generator", select "bot" scope with "Send Messages" + "Read Messages" permissions',
      'Use the generated URL to invite the bot to your server',
    ],
    tokenLabel: 'Bot Token',
    tokenHelp: 'From Discord Developer Portal > Your App > Bot > Token',
    configFields: [
      { key: 'channelIds', label: 'Channel IDs', placeholder: '123456789,987654321', help: 'Leave empty to listen in all channels the bot can see' },
    ],
  },
  {
    id: 'telegram',
    label: 'Telegram',
    color: '#229ED9',
    icon: 'TG',
    setupSteps: [
      'Message @BotFather on Telegram',
      'Send /newbot and follow the prompts to create a bot',
      'Copy the bot token BotFather gives you',
    ],
    tokenLabel: 'Bot Token',
    tokenHelp: 'From @BotFather after creating your bot',
    configFields: [
      { key: 'chatIds', label: 'Chat IDs', placeholder: '-100123456789', help: 'Leave empty to respond in all chats. Use negative IDs for groups.' },
    ],
  },
  {
    id: 'slack',
    label: 'Slack',
    color: '#4A154B',
    icon: 'SL',
    setupSteps: [
      'Go to api.slack.com/apps and create a new app "From scratch"',
      'Under "Socket Mode", enable it and generate an App-Level Token (xapp-...)',
      'Under "OAuth & Permissions", add bot scopes: chat:write, app_mentions:read, channels:read, users:read',
      'Under "Event Subscriptions", enable events and subscribe to: message.channels, app_mention',
      'Install the app to your workspace and copy the Bot Token (xoxb-...)',
    ],
    tokenLabel: 'Bot Token (xoxb-...)',
    tokenHelp: 'From Slack App > OAuth & Permissions > Bot User OAuth Token',
    configFields: [
      { key: 'appToken', label: 'App-Level Token (xapp-...)', placeholder: 'xapp-1-...', help: 'Required for Socket Mode. From Slack App > Basic Information > App-Level Tokens' },
      { key: 'channelIds', label: 'Channel IDs', placeholder: 'C0123456789', help: 'Leave empty to listen in all channels the bot is in' },
    ],
  },
  {
    id: 'whatsapp',
    label: 'WhatsApp',
    color: '#25D366',
    icon: 'WA',
    setupSteps: [
      'No token needed — WhatsApp uses QR code pairing',
      'When you start this connector, a QR code will appear in the server terminal',
      'Open WhatsApp > Settings > Linked Devices > Link a Device',
      'Scan the QR code to connect',
    ],
    tokenLabel: '',
    tokenHelp: '',
    configFields: [
      { key: 'allowedJids', label: 'Allowed Numbers/Groups', placeholder: '1234567890,MyGroup', help: 'Leave empty to respond to all messages' },
    ],
  },
]

export function ConnectorSheet() {
  const open = useAppStore((s) => s.connectorSheetOpen)
  const setOpen = useAppStore((s) => s.setConnectorSheetOpen)
  const editingId = useAppStore((s) => s.editingConnectorId)
  const setEditingId = useAppStore((s) => s.setEditingConnectorId)
  const connectors = useAppStore((s) => s.connectors)
  const loadConnectors = useAppStore((s) => s.loadConnectors)
  const agents = useAppStore((s) => s.agents)
  const credentials = useAppStore((s) => s.credentials)
  const loadAgents = useAppStore((s) => s.loadAgents)
  const loadCredentials = useAppStore((s) => s.loadCredentials)

  const [name, setName] = useState('')
  const [platform, setPlatform] = useState<ConnectorPlatform>('discord')
  const [agentId, setAgentId] = useState('')
  const [credentialId, setCredentialId] = useState('')
  const [config, setConfig] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [actionLoading, setActionLoading] = useState(false)
  const [showSetup, setShowSetup] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)

  const editing = editingId ? connectors[editingId] as Connector | undefined : null

  useEffect(() => {
    if (open) {
      loadAgents()
      loadCredentials()
      setShowSetup(false)
    }
  }, [open])

  useEffect(() => {
    if (editing) {
      setName(editing.name)
      setPlatform(editing.platform)
      setAgentId(editing.agentId)
      setCredentialId(editing.credentialId || '')
      setConfig(editing.config || {})
    } else {
      setName('')
      setPlatform('discord')
      setAgentId('')
      setCredentialId('')
      setConfig({})
    }
    setQrDataUrl(null)
  }, [editing, open])

  // Poll for QR code when WhatsApp connector is running
  useEffect(() => {
    if (!editing || editing.platform !== 'whatsapp' || editing.status !== 'running') {
      setQrDataUrl(null)
      return
    }
    let cancelled = false
    const poll = async () => {
      try {
        const data = await api<any>('GET', `/connectors/${editing.id}`)
        if (!cancelled) {
          setQrDataUrl(data.qrDataUrl || null)
          // Refresh connector list to update status (e.g. when pairing completes)
          loadConnectors()
        }
      } catch { /* ignore */ }
    }
    poll()
    const interval = setInterval(poll, 2000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [editing?.id, editing?.platform, editing?.status])

  const handleSave = async () => {
    if (!agentId) return
    setSaving(true)
    try {
      if (editing) {
        await api('PUT', `/connectors/${editing.id}`, { name, agentId, credentialId: credentialId || null, config })
      } else {
        await api('POST', '/connectors', { name: name || `${platformConfig?.label} Bot`, platform, agentId, credentialId: credentialId || null, config })
      }
      await loadConnectors()
      setOpen(false)
      setEditingId(null)
    } catch (err: any) {
      alert(err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleStartStop = async (action: 'start' | 'stop') => {
    if (!editing) return
    setActionLoading(true)
    try {
      await api('PUT', `/connectors/${editing.id}`, { action })
      await loadConnectors()
    } catch (err: any) {
      alert(`Failed to ${action}: ${err.message}`)
    } finally {
      setActionLoading(false)
    }
  }

  const handleDelete = async () => {
    if (!editing || !confirm('Delete this connector?')) return
    await api('DELETE', `/connectors/${editing.id}`)
    await loadConnectors()
    setOpen(false)
    setEditingId(null)
  }

  const platformConfig = PLATFORMS.find((p) => p.id === platform)!
  const agentList = Object.values(agents)
  const credList = Object.values(credentials)

  const inputClass = "w-full px-4 py-3 rounded-[12px] border border-white/[0.08] bg-surface text-text text-[14px] outline-none transition-all placeholder:text-text-3/50 focus:border-white/[0.15]"

  return (
    <BottomSheet open={open} onClose={() => { setOpen(false); setEditingId(null) }} wide>
      <div className="mb-8">
        <h2 className="font-display text-[28px] font-700 tracking-[-0.03em] mb-2">
          {editing ? 'Edit Connector' : 'New Connector'}
        </h2>
        <p className="text-[14px] text-text-3">Bridge a chat platform to an AI agent</p>
      </div>

      {/* Platform selector (only for new) */}
      {!editing && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Platform</label>
          <div className="grid grid-cols-2 gap-3">
            {PLATFORMS.map((p) => (
              <button
                key={p.id}
                onClick={() => { setPlatform(p.id); setShowSetup(false) }}
                className={`flex items-center gap-3 p-4 rounded-[14px] cursor-pointer transition-all duration-200 border text-left
                  ${platform === p.id
                    ? 'bg-white/[0.04] border-white/[0.15] shadow-[0_0_20px_rgba(255,255,255,0.02)]'
                    : 'bg-transparent border-white/[0.04] hover:border-white/[0.08] hover:bg-white/[0.01]'}`}
                style={{ fontFamily: 'inherit' }}
              >
                <div className="w-10 h-10 rounded-[10px] flex items-center justify-center text-white text-[12px] font-800 shrink-0"
                  style={{ backgroundColor: p.color }}>
                  {p.icon}
                </div>
                <div>
                  <div className={`text-[14px] font-600 ${platform === p.id ? 'text-text' : 'text-text-2'}`}>{p.label}</div>
                  <div className="text-[11px] text-text-3 mt-0.5">
                    {p.id === 'whatsapp' ? 'QR code pairing' : 'Bot token'}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Editing: show platform badge */}
      {editing && (
        <div className="mb-6 flex items-center gap-3">
          <div className="w-10 h-10 rounded-[10px] flex items-center justify-center text-white text-[12px] font-800"
            style={{ backgroundColor: platformConfig.color }}>
            {platformConfig.icon}
          </div>
          <div>
            <div className="text-[14px] font-600 text-text">{platformConfig.label}</div>
            <div className="flex items-center gap-2 mt-0.5">
              <span className={`w-2 h-2 rounded-full ${
                editing.status === 'running' ? 'bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.5)]' :
                editing.status === 'error' ? 'bg-red-400' : 'bg-white/20'
              }`} />
              <span className="text-[12px] text-text-3 capitalize">{editing.status}</span>
            </div>
          </div>
        </div>
      )}

      {/* Setup guide (collapsible) */}
      <div className="mb-6">
        <button
          onClick={() => setShowSetup(!showSetup)}
          className="flex items-center gap-2 text-[13px] font-600 text-accent-bright hover:text-accent-bright/80 transition-colors cursor-pointer bg-transparent border-none"
          style={{ fontFamily: 'inherit' }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
            className={`transition-transform ${showSetup ? 'rotate-90' : ''}`}>
            <polyline points="9 18 15 12 9 6" />
          </svg>
          {platformConfig.label} Setup Guide
        </button>
        {showSetup && (
          <div className="mt-3 p-4 rounded-[12px] border border-white/[0.06] bg-white/[0.01] space-y-2.5"
            style={{ animation: 'fade-in 0.2s ease-out' }}>
            {platformConfig.setupSteps.map((step, i) => (
              <div key={i} className="flex items-start gap-3">
                <span className="w-5 h-5 rounded-full bg-white/[0.06] flex items-center justify-center text-[10px] font-700 text-text-3 shrink-0 mt-0.5">
                  {i + 1}
                </span>
                <span className="text-[13px] text-text-2/80 leading-[1.5]">{step}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Name */}
      <div className="mb-6">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={`My ${platformConfig.label} Bot`}
          className={inputClass}
          style={{ fontFamily: 'inherit' }}
        />
      </div>

      {/* Agent selector */}
      <div className="mb-6">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">Route to Agent</label>
        <p className="text-[12px] text-text-3/60 mb-2">Incoming messages will be handled by this agent</p>
        <select
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          className={`${inputClass} appearance-none cursor-pointer`}
          style={{ fontFamily: 'inherit' }}
        >
          <option value="">Select a agent...</option>
          {agentList.map((p: any) => (
            <option key={p.id} value={p.id}>{p.name}{p.isOrchestrator ? ' (Orchestrator)' : ''}</option>
          ))}
        </select>
      </div>

      {/* Bot token credential */}
      {platform !== 'whatsapp' && (
        <div className="mb-6">
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">{platformConfig.tokenLabel}</label>
          <p className="text-[12px] text-text-3/60 mb-2">{platformConfig.tokenHelp}</p>
          <select
            value={credentialId}
            onChange={(e) => setCredentialId(e.target.value)}
            className={`${inputClass} appearance-none cursor-pointer`}
            style={{ fontFamily: 'inherit' }}
          >
            <option value="">Select saved credential...</option>
            {credList.map((c: any) => (
              <option key={c.id} value={c.id}>{c.name} ({c.provider})</option>
            ))}
          </select>
          <p className="text-[11px] text-text-3/50 mt-1.5">
            Save your bot token as a credential in Settings first
          </p>
        </div>
      )}

      {/* Platform-specific config */}
      {platformConfig.configFields.map((field) => (
        <div key={field.key} className="mb-6">
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
            {field.label} <span className="normal-case tracking-normal font-normal text-text-3">(optional)</span>
          </label>
          {field.help && <p className="text-[12px] text-text-3/60 mb-2">{field.help}</p>}
          <input
            value={config[field.key] || ''}
            onChange={(e) => setConfig({ ...config, [field.key]: e.target.value })}
            placeholder={field.placeholder}
            className={`${inputClass} font-mono text-[13px]`}
            style={{ fontFamily: undefined }}
          />
        </div>
      ))}

      {/* Start/Stop controls for editing */}
      {editing && (
        <div className="mb-6 p-4 rounded-[14px] border border-white/[0.06] bg-white/[0.01]">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[13px] font-600 text-text-2">Connection</div>
              <div className="text-[12px] text-text-3 mt-0.5 flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full inline-block ${
                  editing.status === 'running' ? 'bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.5)]' :
                  editing.status === 'error' ? 'bg-red-400' : 'bg-white/20'
                }`} />
                {editing.status === 'running' ? 'Connected and listening' :
                 editing.status === 'error' ? 'Error — see below' : 'Not connected'}
              </div>
            </div>
            {editing.status === 'running' ? (
              <button
                onClick={() => handleStartStop('stop')}
                disabled={actionLoading}
                className="px-5 py-2 rounded-[10px] bg-red-500/15 text-red-400 text-[13px] font-600 cursor-pointer border border-red-500/20 hover:bg-red-500/25 transition-all disabled:opacity-50"
                style={{ fontFamily: 'inherit' }}
              >
                {actionLoading ? 'Stopping...' : 'Disconnect'}
              </button>
            ) : (
              <button
                onClick={() => handleStartStop('start')}
                disabled={actionLoading}
                className="px-5 py-2 rounded-[10px] bg-green-500/15 text-green-400 text-[13px] font-600 cursor-pointer border border-green-500/20 hover:bg-green-500/25 transition-all disabled:opacity-50"
                style={{ fontFamily: 'inherit' }}
              >
                {actionLoading ? 'Connecting...' : 'Connect'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* WhatsApp QR code */}
      {editing && editing.platform === 'whatsapp' && editing.status === 'running' && qrDataUrl && (
        <div className="mb-6 p-5 rounded-[14px] border border-white/[0.06] bg-white/[0.01] text-center"
          style={{ animation: 'fade-in 0.3s ease-out' }}>
          <div className="text-[13px] font-600 text-text-2 mb-1">Scan with WhatsApp</div>
          <p className="text-[11px] text-text-3 mb-4">
            Open WhatsApp &gt; Settings &gt; Linked Devices &gt; Link a Device
          </p>
          <div className="inline-block p-2 bg-white rounded-[12px]">
            <img src={qrDataUrl} alt="WhatsApp QR Code" className="w-[240px] h-[240px]" />
          </div>
          <p className="text-[11px] text-text-3 mt-3">QR code refreshes automatically</p>
        </div>
      )}

      {/* WhatsApp waiting for QR */}
      {editing && editing.platform === 'whatsapp' && editing.status === 'running' && !qrDataUrl && (
        <div className="mb-6 p-5 rounded-[14px] border border-white/[0.06] bg-white/[0.01] text-center">
          <div className="text-[13px] font-600 text-green-400 mb-1">Connected</div>
          <p className="text-[11px] text-text-3">WhatsApp is paired and listening for messages</p>
        </div>
      )}

      {/* Error display */}
      {editing?.lastError && (
        <div className="mb-6 p-4 rounded-[14px] bg-red-500/[0.06] border border-red-500/15">
          <div className="text-[12px] font-600 text-red-400 mb-1">Error</div>
          <div className="text-[12px] text-red-400/70 leading-[1.5] font-mono">{editing.lastError}</div>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-3 pt-4 border-t border-white/[0.04]">
        {editing && (
          <button onClick={handleDelete} className="py-3.5 px-6 rounded-[14px] border border-red-500/20 bg-transparent text-red-400 text-[15px] font-600 cursor-pointer hover:bg-red-500/10 transition-all" style={{ fontFamily: 'inherit' }}>
            Delete
          </button>
        )}
        <button
          onClick={() => { setOpen(false); setEditingId(null) }}
          className="flex-1 py-3.5 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[15px] font-600 cursor-pointer hover:bg-surface-2 transition-all"
          style={{ fontFamily: 'inherit' }}
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving || !agentId}
          className="flex-1 py-3.5 rounded-[14px] border-none bg-[#6366F1] text-white text-[15px] font-600 cursor-pointer active:scale-[0.97] disabled:opacity-30 transition-all shadow-[0_4px_20px_rgba(99,102,241,0.25)] hover:brightness-110"
          style={{ fontFamily: 'inherit' }}
        >
          {saving ? 'Saving...' : editing ? 'Save' : 'Create Connector'}
        </button>
      </div>
    </BottomSheet>
  )
}
