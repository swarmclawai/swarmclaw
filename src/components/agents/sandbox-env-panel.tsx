'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api-client'

export function SandboxEnvPanel() {
  const [available, setAvailable] = useState<string[]>([])
  const [allowed, setAllowed] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api<{ available: string[]; allowed: string[] }>('GET', '/openclaw/sandbox-env')
      setAvailable(res.available)
      setAllowed(new Set(res.allowed))
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const toggle = async (key: string) => {
    const next = new Set(allowed)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setAllowed(next)

    setSaving(true)
    setError('')
    try {
      await api('PUT', '/openclaw/sandbox-env', { allowed: Array.from(next) })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="text-[12px] text-text-3/50 py-2">Loading env keys...</div>

  if (!available.length) {
    return <div className="text-[12px] text-text-3/50 py-2">No .env keys found on gateway.</div>
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="block text-[11px] font-600 uppercase tracking-wider text-text-3/50">Sandbox Env Allowlist</label>
      <div className="flex flex-col gap-1">
        {available.map((key) => (
          <label key={key} className="flex items-center gap-2 py-1 px-2 rounded-[8px] hover:bg-white/[0.02] cursor-pointer transition-colors">
            <input
              type="checkbox"
              checked={allowed.has(key)}
              onChange={() => toggle(key)}
              disabled={saving}
              className="accent-accent-bright"
            />
            <span className="text-[12px] font-mono text-text">{key}</span>
          </label>
        ))}
      </div>
      {error && <p className="text-[12px] text-red-400">{error}</p>}
    </div>
  )
}
