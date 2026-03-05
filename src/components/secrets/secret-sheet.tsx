'use client'

import { useEffect, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { api } from '@/lib/api-client'
import { toast } from 'sonner'

const inputClass = 'w-full px-4 py-3 rounded-[14px] bg-bg border border-white/[0.06] text-text text-[14px] outline-none focus:border-accent-bright/40 transition-colors placeholder:text-text-3/70'

export function SecretSheet() {
  const open = useAppStore((s) => s.secretSheetOpen)
  const setOpen = useAppStore((s) => s.setSecretSheetOpen)
  const editingId = useAppStore((s) => s.editingSecretId)
  const setEditingId = useAppStore((s) => s.setEditingSecretId)
  const secrets = useAppStore((s) => s.secrets)
  const loadSecrets = useAppStore((s) => s.loadSecrets)
  const agents = useAppStore((s) => s.agents)
  const loadAgents = useAppStore((s) => s.loadAgents)

  const [name, setName] = useState('')
  const [service, setService] = useState('')
  const [value, setValue] = useState('')
  const [scope, setScope] = useState<'global' | 'agent'>('global')
  const [agentIds, setAgentIds] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  const editing = editingId ? secrets[editingId] : null
  const agentList = Object.values(agents)

  useEffect(() => {
    if (open) loadAgents()
  }, [open])

  useEffect(() => {
    if (editing) {
      setName(editing.name)
      setService(editing.service)
      setValue('')
      setScope(editing.scope)
      setAgentIds(editing.agentIds || [])
    } else {
      setName('')
      setService('')
      setValue('')
      setScope('global')
      setAgentIds([])
    }
  }, [editing, open])

  const handleClose = () => {
    setOpen(false)
    setEditingId(null)
  }

  const handleSave = async () => {
    if (!name.trim() || (!editing && !value.trim())) return
    setSaving(true)
    try {
      if (editing) {
        await api('PUT', `/secrets/${editing.id}`, {
          name: name.trim(),
          service: service.trim(),
          scope,
          agentIds: scope === 'agent' ? agentIds : [],
        })
        toast.success('Secret updated')
      } else {
        await api('POST', '/secrets', {
          name: name.trim(),
          service: service.trim(),
          value: value.trim(),
          scope,
          agentIds: scope === 'agent' ? agentIds : [],
        })
        toast.success('Secret created')
      }
      await loadSecrets()
      handleClose()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to save secret')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!editing) return
    if (!confirm(`Delete secret "${editing.name}"?`)) return
    try {
      await api('DELETE', `/secrets/${editing.id}`)
      toast.success('Secret deleted')
      await loadSecrets()
      handleClose()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete secret')
    }
  }

  const toggleAgent = (id: string) => {
    setAgentIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])
  }

  const scopeHelperText = scope === 'global'
    ? 'This secret will be accessible to all agents'
    : agentIds.length === 0
      ? 'Select which agents can access this secret'
      : `${agentIds.length} agent(s) selected`

  return (
    <BottomSheet open={open} onClose={handleClose}>
      <div className="space-y-5">
        <h2 className="font-display text-[20px] font-700 tracking-[-0.02em]">{editing ? 'Edit Secret' : 'New Secret'}</h2>
        <div>
          <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Name</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. My Gmail API Key" className={inputClass} style={{ fontFamily: 'inherit' }} />
        </div>

        <div>
          <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Service</label>
          <input type="text" value={service} onChange={(e) => setService(e.target.value)} placeholder="e.g. gmail, ahrefs, custom" className={inputClass} style={{ fontFamily: 'inherit' }} />
        </div>

        <div>
          <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">
            {editing ? 'Value (leave blank to keep current)' : 'Value'}
          </label>
          <input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="API key, password, token..." className={inputClass} style={{ fontFamily: 'inherit' }} />
        </div>

        <div>
          <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Scope</label>
          <div className="flex p-1 rounded-[12px] bg-bg border border-white/[0.06]">
            {(['global', 'agent'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setScope(s)}
                className={`flex-1 py-2.5 rounded-[10px] text-center cursor-pointer transition-all text-[13px] font-600 border-none ${
                  scope === s ? 'bg-accent-soft text-accent-bright' : 'bg-transparent text-text-3 hover:text-text-2'
                }`}
                style={{ fontFamily: 'inherit' }}
              >
                {s === 'global' ? 'Global' : 'Specific'}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-text-3/60 mt-1.5 pl-1">{scopeHelperText}</p>
        </div>

        {scope === 'agent' && (
          <div>
            <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Agents</label>
            <div className="max-h-[240px] overflow-y-auto rounded-[12px] border border-white/[0.06] bg-white/[0.03]">
              {agentList.length === 0 ? (
                <p className="p-3 text-[12px] text-text-3">No agents available</p>
              ) : (
                agentList.map((agent) => {
                  const selected = agentIds.includes(agent.id)
                  return (
                    <button
                      key={agent.id}
                      onClick={() => toggleAgent(agent.id)}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-all cursor-pointer ${
                        selected ? 'bg-accent-soft/40' : 'hover:bg-white/[0.04]'
                      }`}
                      style={{ fontFamily: 'inherit' }}
                    >
                      <AgentAvatar seed={agent.avatarSeed} avatarUrl={agent.avatarUrl} name={agent.name} size={24} />
                      <span className="text-[13px] text-text flex-1 truncate">{agent.name}</span>
                      {selected && (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-accent-bright shrink-0">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </button>
                  )
                })
              )}
            </div>
          </div>
        )}

        <div className="flex gap-3 pt-3">
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
          <button onClick={handleClose} className="px-5 py-3 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[14px] font-600 cursor-pointer hover:bg-surface-2 transition-colors" style={{ fontFamily: 'inherit' }}>Cancel</button>
          <button
            onClick={handleSave}
            disabled={saving || !name.trim() || (!editing && !value.trim())}
            className="px-8 py-3 rounded-[14px] border-none bg-accent-bright text-white text-[14px] font-600 cursor-pointer disabled:opacity-30 transition-all hover:brightness-110"
            style={{ fontFamily: 'inherit' }}
          >
            {saving ? 'Saving...' : editing ? 'Update' : 'Save'}
          </button>
        </div>
      </div>
    </BottomSheet>
  )
}
