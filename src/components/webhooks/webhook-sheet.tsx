'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import { api } from '@/lib/api-client'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { Webhook } from '@/types'

type WebhookApiResponse = Webhook | { error: string }
type DeleteWebhookResponse = { ok: boolean } | { error: string }

const inputClass = 'w-full px-4 py-3 rounded-[14px] bg-bg border border-white/[0.06] text-text text-[14px] outline-none focus:border-accent-bright/40 transition-colors placeholder:text-text-3/40'

function webhookUrl(id: string): string {
  if (typeof window === 'undefined') return `/api/webhooks/${id}`
  return `${window.location.origin}/api/webhooks/${id}`
}

function parseEvents(input: string): string[] {
  const values = input
    .split(/[\n,]+/)
    .map((v) => v.trim())
    .filter(Boolean)
  return Array.from(new Set(values))
}

function makeSecret(length = 28): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const arr = new Uint8Array(length)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(arr)
  } else {
    for (let i = 0; i < length; i++) arr[i] = Math.floor(Math.random() * 256)
  }
  let out = ''
  for (let i = 0; i < length; i++) out += chars[arr[i] % chars.length]
  return out
}

export function WebhookSheet() {
  const open = useAppStore((s) => s.webhookSheetOpen)
  const setOpen = useAppStore((s) => s.setWebhookSheetOpen)
  const editingId = useAppStore((s) => s.editingWebhookId)
  const setEditingId = useAppStore((s) => s.setEditingWebhookId)
  const webhooks = useAppStore((s) => s.webhooks)
  const loadWebhooks = useAppStore((s) => s.loadWebhooks)
  const agents = useAppStore((s) => s.agents)
  const loadAgents = useAppStore((s) => s.loadAgents)

  const [name, setName] = useState('')
  const [source, setSource] = useState('custom')
  const [eventsText, setEventsText] = useState('')
  const [agentId, setAgentId] = useState('')
  const [secret, setSecret] = useState('')
  const [isEnabled, setIsEnabled] = useState(true)
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState<'endpoint' | 'secret' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const editing = editingId ? (webhooks[editingId] as Webhook | undefined) : null
  const endpoint = editing ? webhookUrl(editing.id) : ''
  const orchestrators = useMemo(
    () => Object.values(agents).filter((a) => a.isOrchestrator),
    [agents]
  )

  useEffect(() => {
    if (open) {
      loadWebhooks()
      loadAgents()
      setCopied(null)
      setError(null)
    }
  }, [open, loadWebhooks, loadAgents])

  useEffect(() => {
    if (editing) {
      setName(editing.name || '')
      setSource(editing.source || 'custom')
      setEventsText((editing.events || []).join(', '))
      setAgentId(editing.agentId || '')
      setSecret(editing.secret || '')
      setIsEnabled(editing.isEnabled !== false)
    } else {
      setName('')
      setSource('custom')
      setEventsText('')
      setAgentId('')
      setSecret(makeSecret())
      setIsEnabled(true)
    }
  }, [editing, open])

  const handleClose = () => {
    setOpen(false)
    setEditingId(null)
  }

  const copyText = async (type: 'endpoint' | 'secret', value: string) => {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setCopied(type)
      setTimeout(() => setCopied((prev) => (prev === type ? null : prev)), 1500)
    } catch {
      // ignore clipboard errors
    }
  }

  const handleSave = async () => {
    if (!agentId) {
      setError('An orchestrator agent is required.')
      return
    }

    const payload = {
      name: name.trim() || 'Unnamed Webhook',
      source: source.trim() || 'custom',
      events: parseEvents(eventsText),
      agentId: agentId || null,
      secret: secret.trim(),
      isEnabled,
    }

    setSaving(true)
    setError(null)
    try {
      if (editing) {
        const updated = await api<WebhookApiResponse>('PUT', `/webhooks/${editing.id}`, payload)
        if ('error' in updated && updated.error) throw new Error(updated.error)
      } else {
        const created = await api<WebhookApiResponse>('POST', '/webhooks', payload)
        if ('error' in created && created.error) throw new Error(created.error)
      }
      await loadWebhooks()
      handleClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save webhook')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!editing || !confirm('Delete this webhook?')) return
    try {
      const res = await api<DeleteWebhookResponse>('DELETE', `/webhooks/${editing.id}`)
      if ('error' in res && res.error) throw new Error(res.error)
      await loadWebhooks()
      handleClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to delete webhook')
    }
  }

  return (
    <BottomSheet open={open} onClose={handleClose} wide>
      <div className="space-y-6">
        <div>
          <h2 className="font-display text-[24px] font-700 tracking-[-0.02em] mb-1">
            {editing ? 'Edit Webhook' : 'New Webhook'}
          </h2>
          <p className="text-[13px] text-text-3">Create an inbound endpoint that triggers an orchestrator</p>
        </div>

        {error && (
          <div className="px-3.5 py-2.5 rounded-[12px] bg-red-500/10 border border-red-500/20 text-[12px] text-red-300">
            {error}
          </div>
        )}

        {editing && (
          <div className="p-4 rounded-[14px] bg-white/[0.02] border border-white/[0.06]">
            <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Endpoint URL</label>
            <div className="flex gap-2">
              <input
                readOnly
                value={endpoint}
                className={`${inputClass} font-mono text-[12px]`}
              />
              <button
                onClick={() => copyText('endpoint', endpoint)}
                className="px-3.5 py-2 rounded-[10px] border border-accent-bright/20 bg-accent-soft/40 text-accent-bright text-[12px] font-600 cursor-pointer hover:bg-accent-soft transition-colors"
                style={{ fontFamily: 'inherit' }}
              >
                {copied === 'endpoint' ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="mt-2 text-[11px] text-text-3/70">
              POST JSON payloads to this URL. Include <code className="font-mono">x-webhook-secret</code> if a secret is set.
            </p>
          </div>
        )}

        <div>
          <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. GitHub Push"
            className={inputClass}
            style={{ fontFamily: 'inherit' }}
          />
        </div>

        <div>
          <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Source</label>
          <input
            type="text"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="custom, github, slack..."
            className={inputClass}
            style={{ fontFamily: 'inherit' }}
          />
        </div>

        <div>
          <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Route to Orchestrator</label>
          <Select
            value={agentId || "__none__"}
            onValueChange={(val) => setAgentId(val === "__none__" ? "" : val)}
          >
            <SelectTrigger className={inputClass}>
              <SelectValue placeholder="Select orchestrator..." />
            </SelectTrigger>
            <SelectContent className="bg-surface border-white/[0.08]">
              <SelectItem value="__none__">Select orchestrator...</SelectItem>
              {orchestrators.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>{agent.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">
            Events <span className="normal-case tracking-normal font-normal text-text-3/70">(optional)</span>
          </label>
          <textarea
            value={eventsText}
            onChange={(e) => setEventsText(e.target.value)}
            placeholder="push, release or *"
            rows={3}
            className={`${inputClass} resize-y min-h-[86px] font-mono text-[12px]`}
            style={{ fontFamily: 'inherit' }}
          />
          <p className="mt-1.5 text-[11px] text-text-3/70">Leave blank for all events. Use commas or new lines. Use <code>*</code> to match all.</p>
        </div>

        <div>
          <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">
            Secret <span className="normal-case tracking-normal font-normal text-text-3/70">(optional but recommended)</span>
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="x-webhook-secret value"
              className={`${inputClass} font-mono text-[12px]`}
              style={{ fontFamily: 'inherit' }}
            />
            <button
              onClick={() => copyText('secret', secret)}
              disabled={!secret.trim()}
              className="px-3.5 py-2 rounded-[10px] border border-white/[0.1] bg-white/[0.04] text-text-2 text-[12px] font-600 cursor-pointer hover:bg-white/[0.08] transition-colors disabled:opacity-40"
              style={{ fontFamily: 'inherit' }}
            >
              {copied === 'secret' ? 'Copied' : 'Copy'}
            </button>
            <button
              onClick={() => setSecret(makeSecret())}
              className="px-3.5 py-2 rounded-[10px] border border-accent-bright/20 bg-accent-soft/40 text-accent-bright text-[12px] font-600 cursor-pointer hover:bg-accent-soft transition-colors"
              style={{ fontFamily: 'inherit' }}
            >
              Regenerate
            </button>
          </div>
        </div>

        <div>
          <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Status</label>
          <div className="flex p-1 rounded-[12px] bg-bg border border-white/[0.06]">
            <button
              onClick={() => setIsEnabled(true)}
              className={`flex-1 py-2.5 rounded-[10px] text-center cursor-pointer transition-all text-[13px] font-600 border-none ${isEnabled ? 'bg-emerald-500/15 text-emerald-300' : 'bg-transparent text-text-3 hover:text-text-2'
                }`}
              style={{ fontFamily: 'inherit' }}
            >
              Enabled
            </button>
            <button
              onClick={() => setIsEnabled(false)}
              className={`flex-1 py-2.5 rounded-[10px] text-center cursor-pointer transition-all text-[13px] font-600 border-none ${!isEnabled ? 'bg-white/[0.08] text-text-2' : 'bg-transparent text-text-3 hover:text-text-2'
                }`}
              style={{ fontFamily: 'inherit' }}
            >
              Disabled
            </button>
          </div>
        </div>

        <div className="flex gap-3 pt-2">
          {editing && (
            <button
              onClick={handleDelete}
              className="px-5 py-3 rounded-[14px] border border-danger/30 bg-transparent text-danger text-[14px] font-600 cursor-pointer hover:bg-danger/10 transition-colors"
              style={{ fontFamily: 'inherit' }}
            >
              Delete
            </button>
          )}
          <div className="flex-1" />
          <button
            onClick={handleClose}
            className="px-5 py-3 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[14px] font-600 cursor-pointer hover:bg-surface-2 transition-colors"
            style={{ fontFamily: 'inherit' }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-8 py-3 rounded-[14px] border-none bg-primary text-primary-foreground text-[14px] font-600 cursor-pointer disabled:opacity-30 transition-all hover:brightness-110 shadow-[0_4px_12px_rgba(var(--primary-rgb),0.2)]"
            style={{ fontFamily: 'inherit' }}
          >
            {saving ? 'Saving...' : editing ? 'Update' : 'Create'}
          </button>
        </div>
      </div>
    </BottomSheet>
  )
}
