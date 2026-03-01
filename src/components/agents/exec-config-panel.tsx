'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api-client'
import type { ExecApprovalConfig, ExecApprovalSnapshot } from '@/types'

interface Props {
  agentId: string
}

export function ExecConfigPanel({ agentId }: Props) {
  const [config, setConfig] = useState<ExecApprovalConfig>({ security: 'deny', askMode: 'off', patterns: [] })
  const [hash, setHash] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [newPattern, setNewPattern] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const snap = await api<ExecApprovalSnapshot>('GET', `/openclaw/exec-config?agentId=${agentId}`)
      setConfig(snap.file)
      setHash(snap.hash)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [agentId])

  useEffect(() => { load() }, [load])

  const save = async (patch: Partial<ExecApprovalConfig>) => {
    const updated = { ...config, ...patch }
    setConfig(updated)
    setSaving(true)
    setError('')
    try {
      const result = await api<{ ok: boolean; hash: string }>('PUT', '/openclaw/exec-config', {
        agentId,
        config: updated,
        baseHash: hash,
      })
      setHash(result.hash)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const addPattern = () => {
    const p = newPattern.trim()
    if (!p || config.patterns.includes(p)) return
    save({ patterns: [...config.patterns, p] })
    setNewPattern('')
  }

  const removePattern = (idx: number) => {
    save({ patterns: config.patterns.filter((_, i) => i !== idx) })
  }

  if (loading) return <div className="p-4 text-[13px] text-text-3/50">Loading exec config...</div>

  return (
    <div className="flex flex-col gap-4">
      {/* Security Level */}
      <div>
        <label className="block text-[11px] font-600 uppercase tracking-wider text-text-3/50 mb-2">Security Level</label>
        <select
          value={config.security}
          onChange={(e) => save({ security: e.target.value as ExecApprovalConfig['security'] })}
          disabled={saving}
          className="w-full px-3 py-2 rounded-[10px] border border-white/[0.06] bg-black/20 text-[13px] text-text outline-none"
        >
          <option value="deny">Deny (block all)</option>
          <option value="allowlist">Allowlist (matched patterns only)</option>
          <option value="full">Full (allow all)</option>
        </select>
      </div>

      {/* Ask Mode */}
      <div>
        <label className="block text-[11px] font-600 uppercase tracking-wider text-text-3/50 mb-2">Ask Mode</label>
        <select
          value={config.askMode}
          onChange={(e) => save({ askMode: e.target.value as ExecApprovalConfig['askMode'] })}
          disabled={saving}
          className="w-full px-3 py-2 rounded-[10px] border border-white/[0.06] bg-black/20 text-[13px] text-text outline-none"
        >
          <option value="off">Off</option>
          <option value="on-miss">On miss (ask when no pattern matches)</option>
          <option value="always">Always ask</option>
        </select>
      </div>

      {/* Patterns */}
      {config.security === 'allowlist' && (
        <div>
          <label className="block text-[11px] font-600 uppercase tracking-wider text-text-3/50 mb-2">
            Allowed Patterns
          </label>
          <div className="flex flex-col gap-1 mb-2">
            {config.patterns.map((p, i) => (
              <div key={i} className="flex items-center gap-2 py-1 px-2 rounded-[8px] bg-white/[0.02] border border-white/[0.04]">
                <span className="text-[12px] text-text font-mono truncate flex-1">{p}</span>
                <button
                  onClick={() => removePattern(i)}
                  disabled={saving}
                  className="text-red-400/60 hover:text-red-400 text-[10px] bg-transparent border-none cursor-pointer"
                >
                  Remove
                </button>
              </div>
            ))}
            {!config.patterns.length && (
              <span className="text-[12px] text-text-3/40">No patterns configured</span>
            )}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={newPattern}
              onChange={(e) => setNewPattern(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addPattern()}
              placeholder="e.g. npm run *"
              className="flex-1 px-3 py-1.5 rounded-[8px] border border-white/[0.06] bg-black/20 text-[12px] text-text font-mono outline-none placeholder:text-text-3/40"
            />
            <button
              onClick={addPattern}
              disabled={saving || !newPattern.trim()}
              className="px-3 py-1.5 rounded-[8px] border-none bg-accent-bright text-white text-[11px] font-600 cursor-pointer disabled:opacity-30 transition-all"
              style={{ fontFamily: 'inherit' }}
            >
              Add
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-[12px] text-red-400">{error}</p>}
      {saving && <p className="text-[11px] text-text-3/50">Saving...</p>}
    </div>
  )
}
