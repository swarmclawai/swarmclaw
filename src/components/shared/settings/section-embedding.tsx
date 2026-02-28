'use client'

import type { SettingsSectionProps } from './types'

interface EmbeddingSectionProps extends SettingsSectionProps {
  credList: Array<{ id: string; name: string; provider: string }>
}

export function EmbeddingSection({ appSettings, patchSettings, inputClass, credList }: EmbeddingSectionProps) {
  return (
    <div className="mb-10">
      <h3 className="font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
        Embeddings
      </h3>
      <p className="text-[12px] text-text-3 mb-5">
        Enable semantic search for agent memory. Requires an embedding model provider.
      </p>
      <div className="p-6 rounded-[18px] bg-surface border border-white/[0.06]">
        <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-3">Provider</label>
        <div className="grid grid-cols-4 gap-2 mb-5">
          {[
            { id: null, name: 'Off' },
            { id: 'local' as const, name: 'Local (Free)' },
            { id: 'openai' as const, name: 'OpenAI' },
            { id: 'ollama' as const, name: 'Ollama' },
          ].map((p) => (
            <button
              key={String(p.id)}
              onClick={() => patchSettings({ embeddingProvider: p.id, embeddingModel: null, embeddingCredentialId: null })}
              className={`py-3 px-3 rounded-[12px] text-center cursor-pointer transition-all text-[13px] font-600 border
                ${(appSettings.embeddingProvider || null) === p.id
                  ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
                  : 'bg-bg border-white/[0.06] text-text-2 hover:bg-surface-2'}`}
              style={{ fontFamily: 'inherit' }}
            >
              {p.name}
            </button>
          ))}
        </div>

        {appSettings.embeddingProvider === 'local' && (
          <p className="text-[12px] text-text-3/80 mb-5">
            Runs <span className="text-text-2 font-600">all-MiniLM-L6-v2</span> locally in Node.js — no API key, no cost, works offline. Model downloads once (~23MB).
          </p>
        )}

        {appSettings.embeddingProvider === 'openai' && (
          <>
            <div className="mb-5">
              <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-3">Model</label>
              <select
                value={appSettings.embeddingModel || 'text-embedding-3-small'}
                onChange={(e) => patchSettings({ embeddingModel: e.target.value })}
                className={`${inputClass} appearance-none cursor-pointer`}
                style={{ fontFamily: 'inherit' }}
              >
                <option value="text-embedding-3-small">text-embedding-3-small</option>
                <option value="text-embedding-3-large">text-embedding-3-large</option>
              </select>
            </div>
            <div>
              <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-3">API Key</label>
              {credList.filter((c) => c.provider === 'openai').length > 0 ? (
                <select
                  value={appSettings.embeddingCredentialId || ''}
                  onChange={(e) => patchSettings({ embeddingCredentialId: e.target.value || null })}
                  className={`${inputClass} appearance-none cursor-pointer`}
                  style={{ fontFamily: 'inherit' }}
                >
                  <option value="">Select a key...</option>
                  {credList.filter((c) => c.provider === 'openai').map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              ) : (
                <p className="text-[12px] text-text-3/60">No OpenAI API keys configured.</p>
              )}
            </div>
          </>
        )}

        {appSettings.embeddingProvider === 'ollama' && (
          <div>
            <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-3">Model</label>
            <input
              type="text"
              value={appSettings.embeddingModel || 'nomic-embed-text'}
              onChange={(e) => patchSettings({ embeddingModel: e.target.value })}
              placeholder="nomic-embed-text"
              className={inputClass}
              style={{ fontFamily: 'inherit' }}
            />
            <p className="text-[11px] text-text-3/60 mt-2">Uses your local Ollama instance for embeddings</p>
          </div>
        )}
      </div>
    </div>
  )
}
