'use client'

import { useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { api } from '@/lib/api-client'
import { toast } from 'sonner'
import type { SettingsSectionProps } from './types'

export function SecretsSection({ appSettings, inputClass }: SettingsSectionProps) {
  const secrets = useAppStore((s) => s.secrets)
  const loadSecrets = useAppStore((s) => s.loadSecrets)
  const agents = useAppStore((s) => s.agents)

  const [addingSecret, setAddingSecret] = useState(false)
  const [secretName, setSecretName] = useState('')
  const [secretService, setSecretService] = useState('')
  const [secretValue, setSecretValue] = useState('')
  const [secretScope, setSecretScope] = useState<'global' | 'agent'>('global')
  const [secretAgentIds, setSecretAgentIds] = useState<string[]>([])
  const [deletingSecret, setDeletingSecret] = useState<string | null>(null)

  const handleAddSecret = async () => {
    if (!secretName.trim() || !secretValue.trim()) return
    try {
      await api('POST', '/secrets', {
        name: secretName,
        service: secretService || 'custom',
        value: secretValue,
        scope: secretScope,
        agentIds: secretScope === 'agent' ? secretAgentIds : [],
      })
      await loadSecrets()
      setAddingSecret(false)
      setSecretName('')
      setSecretService('')
      setSecretValue('')
      setSecretScope('global')
      setSecretAgentIds([])
      toast.success('Credential added')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to add credential')
    }
  }

  const handleDeleteSecret = async (id: string) => {
    try {
      await api('DELETE', `/secrets/${id}`)
      await loadSecrets()
      setDeletingSecret(null)
      toast.success('Credential deleted')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete credential')
    }
  }

  const orchestrators = Object.values(agents).filter((p) => p.isOrchestrator)
  const secretList = Object.entries(secrets).map(([rowId, secret]) => ({ ...secret, rowId }))

  return (
    <div className="mb-10">
      <h3 className="font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
        Service Credentials
      </h3>
      <p className="text-[12px] text-text-3 mb-5">
        Credentials for external services (Gmail, APIs, etc.) that orchestrators can use during task execution.
      </p>

      {secretList.length > 0 && (
        <div className="space-y-2.5 mb-4">
          {secretList.map((secret) => (
            <div key={secret.rowId} className="flex items-center gap-3 py-3 px-4 rounded-[14px] bg-surface border border-white/[0.06]">
              <div className="flex-1 min-w-0">
                <div className="text-[14px] font-600 text-text truncate">{secret.name}</div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-[11px] font-mono text-text-3">{secret.service}</span>
                  <span className={`text-[10px] font-600 px-1.5 py-0.5 rounded-[4px] ${
                    secret.scope === 'global'
                      ? 'bg-emerald-500/10 text-emerald-400'
                      : 'bg-amber-500/10 text-amber-400'
                  }`}>
                    {secret.scope === 'global' ? 'All orchestrators' : `${secret.agentIds.length} orchestrator(s)`}
                  </span>
                </div>
              </div>
              {deletingSecret === secret.rowId ? (
                <div className="flex gap-2">
                  <button onClick={() => setDeletingSecret(null)} className="px-3 py-1.5 text-[13px] font-600 bg-transparent border-none text-text-3 cursor-pointer hover:text-text-2 transition-colors" style={{ fontFamily: 'inherit' }}>Keep</button>
                  <button onClick={() => handleDeleteSecret(secret.rowId)} className="px-3 py-1.5 text-[13px] font-600 bg-danger text-white border-none cursor-pointer rounded-[8px] transition-colors hover:brightness-110" style={{ fontFamily: 'inherit' }}>Delete</button>
                </div>
              ) : (
                <button onClick={() => setDeletingSecret(secret.rowId)} className="px-3 py-1.5 text-[13px] font-500 bg-transparent border-none text-text-3 cursor-pointer hover:text-danger transition-colors" style={{ fontFamily: 'inherit' }}>Remove</button>
              )}
            </div>
          ))}
        </div>
      )}

      {addingSecret ? (
        <div className="p-6 rounded-[18px] bg-surface border border-white/[0.06] space-y-4">
          <div className="font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em]">New Secret</div>
          <input type="text" value={secretName} onChange={(e) => setSecretName(e.target.value)} placeholder="Name (e.g. My Gmail)" className={inputClass} style={{ fontFamily: 'inherit' }} />
          <input type="text" value={secretService} onChange={(e) => setSecretService(e.target.value)} placeholder="Service (e.g. gmail, ahrefs, custom)" className={inputClass} style={{ fontFamily: 'inherit' }} />
          <input type="password" value={secretValue} onChange={(e) => setSecretValue(e.target.value)} placeholder="Value (API key, password, token...)" className={inputClass} style={{ fontFamily: 'inherit' }} />

          <div>
            <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Scope</label>
            <div className="flex p-1 rounded-[12px] bg-bg border border-white/[0.06]">
              {(['global', 'agent'] as const).map((s) => (
                <button key={s} onClick={() => setSecretScope(s)} className={`flex-1 py-2.5 rounded-[10px] text-center cursor-pointer transition-all text-[13px] font-600 capitalize ${secretScope === s ? 'bg-accent-soft text-accent-bright' : 'bg-transparent text-text-3 hover:text-text-2'}`} style={{ fontFamily: 'inherit' }}>{s === 'global' ? 'All Orchestrators' : 'Specific'}</button>
              ))}
            </div>
          </div>

          {secretScope === 'agent' && orchestrators.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {orchestrators.map((p) => (
                <button key={p.id} onClick={() => setSecretAgentIds((prev) => prev.includes(p.id) ? prev.filter((x) => x !== p.id) : [...prev, p.id])} className={`px-3 py-2 rounded-[10px] text-[12px] font-600 cursor-pointer transition-all border ${secretAgentIds.includes(p.id) ? 'bg-accent-soft border-accent-bright/25 text-accent-bright' : 'bg-bg border-white/[0.06] text-text-3 hover:text-text-2'}`} style={{ fontFamily: 'inherit' }}>{p.name}</button>
              ))}
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button onClick={() => setAddingSecret(false)} className="flex-1 py-3 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[14px] font-600 cursor-pointer hover:bg-surface-2 transition-colors" style={{ fontFamily: 'inherit' }}>Cancel</button>
            <button onClick={handleAddSecret} disabled={!secretName.trim() || !secretValue.trim()} className="flex-1 py-3 rounded-[14px] border-none bg-[#6366F1] text-white text-[14px] font-600 cursor-pointer disabled:opacity-30 transition-all hover:brightness-110" style={{ fontFamily: 'inherit' }}>Save Secret</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAddingSecret(true)} className="w-full py-3 rounded-[12px] border border-dashed border-white/[0.1] bg-transparent text-text-3 text-[13px] font-600 cursor-pointer hover:border-accent-bright/30 hover:text-accent-bright hover:bg-accent-soft transition-all duration-200" style={{ fontFamily: 'inherit' }}>+ Add Service Credential</button>
      )}
    </div>
  )
}
