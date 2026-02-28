'use client'

import { useState, useEffect } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import { api } from '@/lib/api-client'
import { toast } from 'sonner'
import type { Connector, ConnectorPlatform } from '@/types'
import { ConnectorPlatformBadge } from '@/components/shared/connector-platform-icon'

/** Auto-detect URLs in text and make them clickable links that open in a new tab */
function linkify(text: string) {
  const urlRegex = /(https?:\/\/[^\s,)]+)/gi
  const parts = text.split(urlRegex)
  if (parts.length === 1) return text
  return parts.map((part, i) => {
    if (urlRegex.test(part)) {
      urlRegex.lastIndex = 0
      return <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="text-accent-bright hover:underline">{part}</a>
    }
    return part
  })
}

const PLATFORMS: {
  id: ConnectorPlatform
  label: string
  color: string
  setupSteps: string[]
  tokenLabel: string
  tokenHelp: string
  configFields: { key: string; label: string; placeholder: string; help?: string }[]
}[] = [
  {
    id: 'discord',
    label: 'Discord',
    color: '#5865F2',
    setupSteps: [
      'Go to https://discord.com/developers/applications and create a new app',
      'Under "Bot", click "Reset Token" and copy it',
      'Enable MESSAGE CONTENT intent under "Privileged Gateway Intents"',
      'Under "OAuth2 > URL Generator", check the "bot" scope — a Bot Permissions panel will appear below',
      'In Bot Permissions, check "Send Messages" and "Read Message History"',
      'Copy the generated URL at the bottom and open it to invite the bot to your server',
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
    setupSteps: [
      'Go to https://api.slack.com/apps and create a new app "From scratch"',
      'Under "Socket Mode", enable it. Then go to "Basic Information > App-Level Tokens", generate a token with connections:write scope, and copy the xapp-... token',
      'Under "OAuth & Permissions", add bot scopes: chat:write, channels:history, channels:read, im:history, im:read, users:read, app_mentions:read',
      'Under "Event Subscriptions", enable events and subscribe to: message.channels, message.im, app_mention',
      'Under "App Home", enable the Messages Tab and check "Allow users to send Slash commands and messages from the messages tab"',
      'Install the app to your workspace and copy the Bot Token (xoxb-...) from OAuth & Permissions',
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
      { key: 'outboundJid', label: 'Default Outbound Recipient', placeholder: '15551234567 or 15551234567@s.whatsapp.net', help: 'Used by connector_message_tool when the agent sends proactive WhatsApp updates without an explicit "to" value' },
    ],
  },
  {
    id: 'openclaw',
    label: 'OpenClaw',
    color: '#F97316',
    setupSteps: [
      'Ensure your OpenClaw instance is running (default: localhost:18789)',
      'If authentication is enabled, create a credential with your OpenClaw gateway token',
      'The connector will connect via OpenClaw Gateway RPC and handle chat events',
    ],
    tokenLabel: 'Gateway Token',
    tokenHelp: 'Required when your OpenClaw gateway is auth-protected',
    configFields: [
      { key: 'wsUrl', label: 'WebSocket URL', placeholder: 'ws://localhost:18789', help: 'OpenClaw gateway WebSocket endpoint (root URL, not /ws)' },
      { key: 'sessionKey', label: 'Session Key Filter', placeholder: 'main', help: 'Optional. If set, only inbound events for this OpenClaw session are processed.' },
      { key: 'nodeId', label: 'Client Label', placeholder: 'swarmclaw', help: 'Optional display label shown in OpenClaw presence metadata.' },
      { key: 'role', label: 'Gateway Role', placeholder: 'operator', help: 'Optional role claim for connect handshake. Default is operator.' },
      { key: 'scopes', label: 'Scopes (CSV)', placeholder: 'operator.read,operator.write', help: 'Optional comma-separated scopes for OpenClaw connect.' },
      { key: 'tickWatchdog', label: 'Tick Watchdog', placeholder: 'true', help: 'Set false to disable stale-tick reconnect watchdog.' },
      { key: 'tickIntervalMs', label: 'Tick Interval Override (ms)', placeholder: '30000', help: 'Optional watchdog interval override when policy tick is unavailable.' },
    ],
  },
  {
    id: 'matrix',
    label: 'Matrix',
    color: '#0DBD8B',
    setupSteps: [
      'Create a bot user on your Matrix homeserver',
      'Generate an access token for the bot user',
      'Set the homeserver URL (e.g. https://matrix.org)',
      'Optionally restrict to specific room IDs',
    ],
    tokenLabel: 'Access Token',
    tokenHelp: 'Matrix access token for the bot user',
    configFields: [
      { key: 'homeserverUrl', label: 'Homeserver URL', placeholder: 'https://matrix.org', help: 'The Matrix homeserver URL' },
      { key: 'roomIds', label: 'Room IDs', placeholder: '!abc123:matrix.org', help: 'Comma-separated room IDs. Leave empty for all rooms.' },
    ],
  },
  {
    id: 'googlechat',
    label: 'Google Chat',
    color: '#00AC47',
    setupSteps: [
      'Create a Google Cloud project and enable the Google Chat API',
      'Create a service account and download the JSON key file',
      'In Google Chat Admin, configure the bot with your app URL',
      'Paste the full service account JSON as the bot token',
    ],
    tokenLabel: 'Service Account JSON',
    tokenHelp: 'Paste the full service account JSON key file contents',
    configFields: [
      { key: 'spaceIds', label: 'Space IDs', placeholder: 'spaces/AAAA123', help: 'Comma-separated Google Chat space IDs' },
    ],
  },
  {
    id: 'teams',
    label: 'Microsoft Teams',
    color: '#6264A7',
    setupSteps: [
      'Register a bot in the Azure Bot Framework portal',
      'Note the Microsoft App ID and generate an App Secret',
      'Set up a public HTTPS endpoint for webhook delivery',
      'Configure the messaging endpoint in Azure to your notify URL',
    ],
    tokenLabel: 'App Secret',
    tokenHelp: 'Microsoft App Secret from Azure Bot registration',
    configFields: [
      { key: 'appId', label: 'Microsoft App ID', placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', help: 'Azure Bot Framework App ID' },
      { key: 'notifyUrl', label: 'Notify URL', placeholder: 'https://your-server.com/api/teams/webhook', help: 'Public HTTPS endpoint for receiving messages' },
    ],
  },
  {
    id: 'signal',
    label: 'Signal',
    color: '#3A76F0',
    setupSteps: [
      'Install signal-cli (https://github.com/AsamK/signal-cli)',
      'Register a phone number: signal-cli -u +1234567890 register',
      'Verify the number: signal-cli -u +1234567890 verify CODE',
      'The connector spawns signal-cli daemon to listen for messages',
    ],
    tokenLabel: '',
    tokenHelp: '',
    configFields: [
      { key: 'phoneNumber', label: 'Phone Number', placeholder: '+1234567890', help: 'Pre-registered Signal phone number' },
      { key: 'signalCliPath', label: 'signal-cli Path', placeholder: 'signal-cli', help: 'Path to signal-cli binary (defaults to signal-cli)' },
      { key: 'signalCliMode', label: 'Mode', placeholder: 'stdio', help: 'stdio (default) or http' },
      { key: 'signalCliHttpUrl', label: 'HTTP API URL', placeholder: 'http://localhost:8080', help: 'Only needed for http mode' },
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
  const [waAuthenticated, setWaAuthenticated] = useState(false)
  const [waHasCreds, setWaHasCreds] = useState(false)
  const [waConnecting, setWaConnecting] = useState(false)
  const [showNewCred, setShowNewCred] = useState(false)
  const [newCredName, setNewCredName] = useState('')
  const [newCredValue, setNewCredValue] = useState('')
  const [savingCred, setSavingCred] = useState(false)

  const editing = editingId ? connectors[editingId] as Connector | undefined : null

  useEffect(() => {
    if (open) {
      loadAgents()
      loadCredentials()
      setShowSetup(false)
    }
  }, [open])

  // Sync form fields when editing connector changes (by ID, not reference)
  const editingIdRef = editing?.id ?? null
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
    setWaAuthenticated(false)
    setWaHasCreds(false)
    setWaConnecting(false)
  }, [editingIdRef, open])

  // Poll for QR code when WhatsApp connector is running or connecting
  const isWaRunning = editing?.platform === 'whatsapp' && (editing?.status === 'running' || waConnecting)
  useEffect(() => {
    if (!editing || !isWaRunning) {
      return
    }
    let cancelled = false
    const poll = async () => {
      try {
        const data = await api<any>('GET', `/connectors/${editing.id}`)
        if (!cancelled) {
          setQrDataUrl(data.qrDataUrl || null)
          setWaAuthenticated(data.authenticated ?? false)
          setWaHasCreds(data.hasCredentials ?? false)
          // Sync store with the individual endpoint's runtime status
          if (data.status === 'running' && editing.status !== 'running') {
            // Store is stale — update it directly
            const store = useAppStore.getState()
            const updated = { ...store.connectors }
            if (updated[editing.id]) {
              updated[editing.id] = { ...updated[editing.id], status: 'running' as const }
              useAppStore.setState({ connectors: updated })
            }
          }
        }
      } catch { /* ignore */ }
    }
    poll()
    const interval = setInterval(poll, 2000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [editing?.id, isWaRunning])

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
      toast.error(err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleStartStop = async (action: 'start' | 'stop') => {
    if (!editing) return
    setActionLoading(true)
    try {
      await api('PUT', `/connectors/${editing.id}`, { action })
      if (action === 'start' && editing.platform === 'whatsapp') {
        setWaConnecting(true)
        setWaAuthenticated(false)
        setQrDataUrl(null)
        // Don't reset waHasCreds — it will be updated by poll
      } else if (action === 'stop') {
        setWaConnecting(false)
        setWaAuthenticated(false)
        setWaHasCreds(false)
        setQrDataUrl(null)
      }
      await loadConnectors()
    } catch (err: any) {
      setWaConnecting(false)
      toast.error(`Failed to ${action}: ${err.message}`)
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
                <ConnectorPlatformBadge platform={p.id} size={40} iconSize={18} />
                <div>
                  <div className={`text-[14px] font-600 ${platform === p.id ? 'text-text' : 'text-text-2'}`}>{p.label}</div>
                  <div className="text-[11px] text-text-3 mt-0.5">
                    {p.id === 'whatsapp' ? 'QR code pairing' : p.id === 'openclaw' ? 'WebSocket gateway' : p.id === 'signal' ? 'signal-cli binary' : p.id === 'matrix' ? 'Access token' : p.id === 'googlechat' ? 'Service account' : p.id === 'teams' ? 'Bot Framework' : 'Bot token'}
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
          <ConnectorPlatformBadge platform={platformConfig.id} size={40} iconSize={18} />
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
                <span className="text-[13px] text-text-2/80 leading-[1.5]">{linkify(step)}</span>
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
          value={agentId || ''}
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
          <div className="flex gap-2">
            <select
              value={credentialId}
              onChange={(e) => {
                if (e.target.value === '__new__') {
                  setShowNewCred(true)
                  setNewCredName(`${platformConfig.label} Bot Token`)
                  setNewCredValue('')
                } else {
                  setCredentialId(e.target.value)
                  setShowNewCred(false)
                }
              }}
              className={`${inputClass} appearance-none cursor-pointer flex-1`}
              style={{ fontFamily: 'inherit' }}
            >
              <option value="">Select credential...</option>
              {credList.map((c: any) => (
                <option key={c.id} value={c.id}>{c.name} ({c.provider})</option>
              ))}
              <option value="__new__">+ Add new key...</option>
            </select>
            {!showNewCred && (
              <button
                type="button"
                onClick={() => {
                  setShowNewCred(true)
                  setNewCredName(`${platformConfig.label} Bot Token`)
                  setNewCredValue('')
                }}
                className="shrink-0 px-3 py-2.5 rounded-[10px] bg-accent-soft/50 text-accent-bright text-[12px] font-600 hover:bg-accent-soft transition-colors cursor-pointer border border-accent-bright/20"
              >
                + New
              </button>
            )}
          </div>
          {showNewCred && (
            <div className="mt-3 p-4 rounded-[12px] border border-accent-bright/15 bg-accent-soft/20 space-y-3"
              style={{ animation: 'fade-in 0.2s ease-out' }}>
              <input
                value={newCredName}
                onChange={(e) => setNewCredName(e.target.value)}
                placeholder="Key name (e.g. My Discord Bot)"
                className={`${inputClass} !bg-surface text-[13px]`}
                style={{ fontFamily: 'inherit' }}
              />
              <input
                type="password"
                value={newCredValue}
                onChange={(e) => setNewCredValue(e.target.value)}
                placeholder="Paste your token here..."
                className={`${inputClass} !bg-surface font-mono text-[13px]`}
                style={{ fontFamily: undefined }}
              />
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => setShowNewCred(false)}
                  className="px-3 py-1.5 text-[12px] text-text-3 hover:text-text-2 transition-colors cursor-pointer bg-transparent border-none"
                  style={{ fontFamily: 'inherit' }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={savingCred || !newCredValue.trim()}
                  onClick={async () => {
                    setSavingCred(true)
                    try {
                      const cred = await api<any>('POST', '/credentials', {
                        provider: platform,
                        name: newCredName.trim() || `${platformConfig.label} Bot Token`,
                        apiKey: newCredValue.trim(),
                      })
                      await loadCredentials()
                      setCredentialId(cred.id)
                      setShowNewCred(false)
                      setNewCredName('')
                      setNewCredValue('')
                    } catch (err: any) {
                      toast.error(`Failed to save: ${err.message}`)
                    } finally {
                      setSavingCred(false)
                    }
                  }}
                  className="px-4 py-1.5 rounded-[8px] bg-accent-bright text-white text-[12px] font-600 cursor-pointer border-none hover:brightness-110 transition-all disabled:opacity-40"
                  style={{ fontFamily: 'inherit' }}
                >
                  {savingCred ? 'Saving...' : 'Save Key'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Platform-specific config */}
      {platformConfig.configFields.map((field) => {
        const isTagField = field.key === 'allowedJids' || field.key === 'channelIds' || field.key === 'chatIds'
        if (isTagField) {
          const tags = (config[field.key] || '').split(',').map((s) => s.trim()).filter(Boolean)
          return (
            <div key={field.key} className="mb-6">
              <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
                {field.label} <span className="normal-case tracking-normal font-normal text-text-3">(optional)</span>
              </label>
              {field.help && <p className="text-[12px] text-text-3/60 mb-2">{field.help}</p>}
              <div className="flex flex-wrap gap-2 mb-2">
                {tags.map((tag, i) => (
                  <span key={i} className="flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] bg-accent-soft/50 border border-accent-bright/20 text-[12px] font-mono text-accent-bright">
                    {tag}
                    <button
                      onClick={() => {
                        const next = tags.filter((_, j) => j !== i).join(',')
                        setConfig({ ...config, [field.key]: next })
                      }}
                      className="ml-0.5 w-4 h-4 flex items-center justify-center rounded-full hover:bg-white/10 transition-colors cursor-pointer text-accent-bright/50 hover:text-accent-bright"
                    >
                      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  id={`tag-input-${field.key}`}
                  placeholder={field.placeholder}
                  className={`${inputClass} font-mono text-[13px] flex-1`}
                  style={{ fontFamily: undefined }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ',') {
                      e.preventDefault()
                      const input = e.currentTarget
                      const val = input.value.trim().replace(/,/g, '')
                      if (val) {
                        const next = tags.length > 0 ? `${tags.join(',')},${val}` : val
                        setConfig({ ...config, [field.key]: next })
                        input.value = ''
                      }
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={() => {
                    const input = document.getElementById(`tag-input-${field.key}`) as HTMLInputElement
                    const val = input?.value.trim().replace(/,/g, '')
                    if (val) {
                      const next = tags.length > 0 ? `${tags.join(',')},${val}` : val
                      setConfig({ ...config, [field.key]: next })
                      input.value = ''
                    }
                  }}
                  className="px-4 py-2.5 rounded-[10px] bg-accent-soft/50 text-accent-bright text-[12px] font-600 hover:bg-accent-soft transition-colors cursor-pointer border border-accent-bright/20"
                >
                  Add
                </button>
              </div>
            </div>
          )
        }
        return (
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
        )
      })}

      {/* Start/Stop controls for editing */}
      {editing && (() => {
        const effectiveRunning = editing.status === 'running' || waConnecting
        return (
        <div className="mb-6 p-4 rounded-[14px] border border-white/[0.06] bg-white/[0.01]">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[13px] font-600 text-text-2">Connection</div>
              <div className="text-[12px] text-text-3 mt-0.5 flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full inline-block ${
                  effectiveRunning ? 'bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.5)]' :
                  editing.status === 'error' ? 'bg-red-400' : 'bg-white/20'
                }`} />
                {effectiveRunning ? (waAuthenticated ? 'Connected and listening' : 'Connecting...') :
                 editing.status === 'error' ? 'Error — see below' : 'Not connected'}
              </div>
            </div>
            {effectiveRunning ? (
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
        )
      })()}

      {/* WhatsApp QR code */}
      {editing && editing.platform === 'whatsapp' && (editing.status === 'running' || waConnecting) && qrDataUrl && (
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

      {/* WhatsApp connected (authenticated, no QR) */}
      {editing && editing.platform === 'whatsapp' && (editing.status === 'running' || waConnecting) && !qrDataUrl && waAuthenticated && (
        <div className="mb-6 p-5 rounded-[14px] border border-white/[0.06] bg-white/[0.01] text-center">
          <div className="text-[13px] font-600 text-green-400 mb-1">Connected</div>
          <p className="text-[11px] text-text-3 mb-3">WhatsApp is paired and listening for messages</p>
          <button
            onClick={async () => {
              if (!confirm('Unlink this device? You will need to scan a new QR code.')) return
              setActionLoading(true)
              try {
                await api('PUT', `/connectors/${editing.id}`, { action: 'repair' })
                setWaAuthenticated(false)
                setWaHasCreds(false)
                setQrDataUrl(null)
                setWaConnecting(true)
                await loadConnectors()
              } catch (err: any) {
                toast.error(`Failed to unlink: ${err.message}`)
              } finally {
                setActionLoading(false)
              }
            }}
            disabled={actionLoading}
            className="text-[12px] text-text-3 hover:text-red-400 transition-colors cursor-pointer bg-transparent border-none underline underline-offset-2"
            style={{ fontFamily: 'inherit' }}
          >
            Unlink device
          </button>
        </div>
      )}

      {/* WhatsApp waiting for QR / reconnecting (not yet authenticated, no QR yet) */}
      {editing && editing.platform === 'whatsapp' && (editing.status === 'running' || waConnecting) && !qrDataUrl && !waAuthenticated && (
        <div className="mb-6 p-5 rounded-[14px] border border-white/[0.06] bg-white/[0.01] text-center">
          <div className="flex items-center justify-center gap-2 mb-1">
            <span className="w-3 h-3 rounded-full border-2 border-[#3B82F6] border-t-transparent animate-spin" />
            <span className="text-[13px] font-600 text-[#3B82F6]">
              {waHasCreds ? 'Reconnecting...' : 'Waiting for QR code...'}
            </span>
          </div>
          <p className="text-[11px] text-text-3">
            {waHasCreds
              ? 'Reconnecting with saved session, this should only take a moment'
              : 'Connecting to WhatsApp, QR code will appear shortly'}
          </p>
          {waHasCreds && (
            <button
              onClick={async () => {
                if (!confirm('Force re-pair? This will clear saved credentials and show a new QR code.')) return
                setActionLoading(true)
                try {
                  await api('PUT', `/connectors/${editing.id}`, { action: 'repair' })
                  setWaAuthenticated(false)
                  setWaHasCreds(false)
                  setQrDataUrl(null)
                  setWaConnecting(true)
                  await loadConnectors()
                } catch (err: any) {
                  toast.error(`Failed to re-pair: ${err.message}`)
                } finally {
                  setActionLoading(false)
                }
              }}
              disabled={actionLoading}
              className="mt-3 text-[12px] text-text-3 hover:text-amber-400 transition-colors cursor-pointer bg-transparent border-none underline underline-offset-2"
              style={{ fontFamily: 'inherit' }}
            >
              Force re-pair with new QR code
            </button>
          )}
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
