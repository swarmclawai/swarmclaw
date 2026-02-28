'use client'

import { useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { createCredential, deleteCredential } from '@/lib/sessions'
import { toast } from 'sonner'
import type { ProviderType } from '@/types'
import type { SettingsSectionProps } from './types'

export function ProvidersSection({ inputClass }: SettingsSectionProps) {
  const providers = useAppStore((s) => s.providers)
  const credentials = useAppStore((s) => s.credentials)
  const loadCredentials = useAppStore((s) => s.loadCredentials)

  const credList = Object.values(credentials)

  const [addProvider, setAddProvider] = useState<ProviderType | null>(null)
  const [newName, setNewName] = useState('')
  const [newKey, setNewKey] = useState('')
  const [deleting, setDeleting] = useState<string | null>(null)

  const handleAdd = async () => {
    if (!addProvider || !newKey.trim()) return
    try {
      await createCredential(addProvider, newName || `${addProvider} key`, newKey)
      await loadCredentials()
      setAddProvider(null)
      setNewName('')
      setNewKey('')
      toast.success('API key added')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to add API key')
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await deleteCredential(id)
      await loadCredentials()
      setDeleting(null)
      toast.success('API key deleted')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete API key')
    }
  }

  return (
    <>
      {/* Providers */}
      <div className="mb-8">
        <h3 className="font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-5">
          Providers
        </h3>
        <div className="space-y-4">
          {providers.map((p) => {
            const providerCreds = credList.filter((c) => c.provider === p.id)
            return (
              <div key={p.id} className="p-6 rounded-[18px] bg-surface border border-white/[0.06]">
                <div className="flex items-center justify-between mb-3">
                  <span className="font-display text-[17px] font-600 tracking-[-0.01em]">{p.name}</span>
                  <span className={`text-[12px] font-600 px-3 py-1 rounded-[8px]
                    ${p.requiresApiKey
                      ? providerCreds.length > 0 ? 'text-success bg-success/[0.1]' : 'text-text-3 bg-white/[0.04]'
                      : 'text-success bg-success/[0.1]'}`}>
                    {p.requiresApiKey
                      ? providerCreds.length > 0 ? 'Connected' : 'No key'
                      : p.optionalApiKey
                        ? providerCreds.length > 0 ? 'Local + Cloud' : 'Local'
                        : p.requiresEndpoint ? 'Local' : 'Built-in'}
                  </span>
                </div>
                <div className="text-[13px] text-text-2/50 font-mono">
                  {p.models.slice(0, 3).join(', ')}
                  {p.models.length > 3 && ` +${p.models.length - 3} more`}
                </div>

                {(p.requiresApiKey || p.optionalApiKey) && providerCreds.length > 0 && (
                  <div className="mt-5 space-y-2.5">
                    {providerCreds.map((cred) => (
                      <div key={cred.id} className="flex items-center gap-3 py-3 px-4 rounded-[12px] bg-bg border border-white/[0.06]">
                        <span className="text-[14px] font-500 flex-1 truncate">{cred.name}</span>
                        {deleting === cred.id ? (
                          <div className="flex gap-2">
                            <button
                              onClick={() => setDeleting(null)}
                              className="px-3 py-1.5 text-[13px] font-600 bg-transparent border-none text-text-3 cursor-pointer hover:text-text-2 transition-colors"
                              style={{ fontFamily: 'inherit' }}
                            >
                              Keep
                            </button>
                            <button
                              onClick={() => handleDelete(cred.id)}
                              className="px-3 py-1.5 text-[13px] font-600 bg-danger text-white border-none cursor-pointer rounded-[8px] transition-colors hover:brightness-110"
                              style={{ fontFamily: 'inherit' }}
                            >
                              Delete
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setDeleting(cred.id)}
                            className="px-3 py-1.5 text-[13px] font-500 bg-transparent border-none text-text-3 cursor-pointer hover:text-danger transition-colors"
                            style={{ fontFamily: 'inherit' }}
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {(p.requiresApiKey || p.optionalApiKey) && (
                  <button
                    onClick={() => setAddProvider(p.id)}
                    className="mt-5 w-full py-3 rounded-[12px] border border-dashed border-white/[0.1]
                      bg-transparent text-text-3 text-[13px] font-600 cursor-pointer
                      hover:border-accent-bright/30 hover:text-accent-bright hover:bg-accent-soft transition-all duration-200"
                    style={{ fontFamily: 'inherit' }}
                  >
                    + Add API Key{p.optionalApiKey && !p.requiresApiKey ? ' (for cloud)' : ''}
                  </button>
                )}

                {p.requiresEndpoint && (
                  <div className="mt-5 text-[13px] text-text-3/50 font-mono">
                    Endpoint: {(p as any).defaultEndpoint || 'http://localhost:11434'}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Add key form */}
      {addProvider && (
        <div className="mb-8 p-6 rounded-[18px] bg-surface border border-white/[0.06]">
          <div className="font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-4">
            New {providers.find((p) => p.id === addProvider)?.name} API Key
          </div>
          <div className="space-y-4">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Key name (optional)"
              className={inputClass}
              style={{ fontFamily: 'inherit' }}
            />
            <input
              type="password"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="sk-..."
              className={inputClass}
              style={{ fontFamily: 'inherit' }}
            />
            <div className="flex gap-3 pt-2">
              <button
                onClick={() => { setAddProvider(null); setNewName(''); setNewKey('') }}
                className="flex-1 py-3 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[14px] font-600 cursor-pointer hover:bg-surface-2 transition-colors"
                style={{ fontFamily: 'inherit' }}
              >
                Cancel
              </button>
              <button
                onClick={handleAdd}
                disabled={!newKey.trim()}
                className="flex-1 py-3 rounded-[14px] border-none bg-[#6366F1] text-white text-[14px] font-600 cursor-pointer disabled:opacity-30 transition-all hover:brightness-110"
                style={{ fontFamily: 'inherit' }}
              >
                Save Key
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
