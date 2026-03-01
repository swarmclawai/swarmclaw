'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api-client'
import type { PermissionPreset } from '@/types'

interface Props {
  agentId: string
  onPresetChanged?: () => void
}

const PRESETS: { id: PermissionPreset; label: string; desc: string; color: string }[] = [
  { id: 'conservative', label: 'Conservative', desc: 'Block all exec, no tools', color: 'text-red-400 bg-red-400/[0.08] border-red-400/20' },
  { id: 'collaborative', label: 'Collaborative', desc: 'Allowlist exec, web + fs tools', color: 'text-amber-300 bg-amber-400/[0.08] border-amber-400/20' },
  { id: 'autonomous', label: 'Autonomous', desc: 'Full exec, all tools', color: 'text-emerald-400 bg-emerald-400/[0.08] border-emerald-400/20' },
]

export function PermissionPresetSelector({ agentId, onPresetChanged }: Props) {
  const [current, setCurrent] = useState<PermissionPreset | 'custom' | null>(null)
  const [loading, setLoading] = useState(true)
  const [applying, setApplying] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api<{ preset: PermissionPreset | 'custom' }>('GET', `/openclaw/permissions?agentId=${agentId}`)
      setCurrent(res.preset)
    } catch {
      setCurrent(null)
    } finally {
      setLoading(false)
    }
  }, [agentId])

  useEffect(() => { load() }, [load])

  const handleSelect = async (preset: PermissionPreset) => {
    if (applying || preset === current) return
    setApplying(true)
    try {
      await api('PUT', '/openclaw/permissions', { agentId, preset })
      setCurrent(preset)
      onPresetChanged?.()
    } catch {
      // ignore
    } finally {
      setApplying(false)
    }
  }

  if (loading) return <div className="text-[12px] text-text-3/50 py-2">Loading presets...</div>

  return (
    <div className="flex flex-col gap-2">
      <label className="block text-[11px] font-600 uppercase tracking-wider text-text-3/50">Permission Preset</label>
      <div className="flex gap-2">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => handleSelect(p.id)}
            disabled={applying}
            className={`flex-1 flex flex-col items-center gap-1 py-2.5 px-2 rounded-[10px] border cursor-pointer transition-all
              ${current === p.id
                ? p.color
                : 'bg-white/[0.02] border-white/[0.06] text-text-3 hover:border-white/[0.12]'
              } ${applying ? 'opacity-50' : ''}`}
            style={{ fontFamily: 'inherit' }}
          >
            <span className="text-[11px] font-600">{p.label}</span>
            <span className="text-[9px] text-text-3/50 text-center leading-tight">{p.desc}</span>
          </button>
        ))}
      </div>
      {current === 'custom' && (
        <span className="text-[10px] text-text-3/50">Custom configuration — select a preset to override</span>
      )}
    </div>
  )
}
