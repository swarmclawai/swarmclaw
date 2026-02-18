'use client'

import { useEffect, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import { api } from '@/lib/api-client'

const inputClass = 'w-full px-4 py-3 rounded-[14px] bg-bg border border-white/[0.06] text-text text-[14px] outline-none focus:border-accent-bright/40 transition-colors placeholder:text-text-3/40'

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
  const orchestrators = Object.values(agents).filter((p) => p.isOrchestrator)

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
      } else {
        await api('POST', '/secrets', {
          name: name.trim(),
          service: service.trim(),
          value: value.trim(),
          scope,
          agentIds: scope === 'agent' ? agentIds : [],
        })
      }
      await loadSecrets()
      handleClose()
    } catch (err: any) {
      console.error('Failed to save secret:', err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!editing) return
    try {
      await api('DELETE', `/secrets/${editing.id}`)
      await loadSecrets()
      handleClose()
    } catch (err: any) {
      console.error('Failed to delete secret:', err.message)
    }
  }

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
                {s === 'global' ? 'All Orchestrators' : 'Specific'}
              </button>
            ))}
          </div>
        </div>

        {scope === 'agent' && orchestrators.length > 0 && (
          <div>
            <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Orchestrators</label>
            <div className="flex flex-wrap gap-2">
              {orchestrators.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setAgentIds((prev) => prev.includes(p.id) ? prev.filter((x) => x !== p.id) : [...prev, p.id])}
                  className={`px-3 py-2 rounded-[10px] text-[12px] font-600 cursor-pointer transition-all border ${
                    agentIds.includes(p.id)
                      ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
                      : 'bg-bg border-white/[0.06] text-text-3 hover:text-text-2'
                  }`}
                  style={{ fontFamily: 'inherit' }}
                >
                  {p.name}
                </button>
              ))}
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
            className="px-8 py-3 rounded-[14px] border-none bg-[#6366F1] text-white text-[14px] font-600 cursor-pointer disabled:opacity-30 transition-all hover:brightness-110"
            style={{ fontFamily: 'inherit' }}
          >
            {saving ? 'Saving...' : editing ? 'Update' : 'Save'}
          </button>
        </div>
      </div>
    </BottomSheet>
  )
}
