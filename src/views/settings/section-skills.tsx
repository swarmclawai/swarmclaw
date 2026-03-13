'use client'

import type { SettingsSectionProps } from './types'

export function SkillsSection({ appSettings, patchSettings, inputClass }: SettingsSectionProps) {
  const mode = appSettings.runtimeSkillRetrievalMode === 'embedding' ? 'embedding' : 'keyword'
  const topK = typeof appSettings.runtimeSkillTopK === 'number' && Number.isFinite(appSettings.runtimeSkillTopK)
    ? appSettings.runtimeSkillTopK
    : 8

  return (
    <div className="mb-10">
      <h3 className="font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
        Skills
      </h3>
      <p className="text-[12px] text-text-3 mb-5">
        Control how runtime skill recommendations are ranked and how many candidates are surfaced per query.
      </p>
      <div className="p-6 rounded-[18px] bg-surface border border-white/[0.06] space-y-5">
        <div>
          <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-3">Recommendation Mode</label>
          <div className="grid grid-cols-2 gap-2">
            {[
              { id: 'keyword' as const, name: 'Keyword', detail: 'Fast lexical matching across skill names, tags, and capabilities.' },
              { id: 'embedding' as const, name: 'Embedding', detail: 'Semantic ranking using the Embeddings settings above, with keyword fallback when unavailable.' },
            ].map((entry) => (
              <button
                key={entry.id}
                onClick={() => patchSettings({ runtimeSkillRetrievalMode: entry.id })}
                className={`rounded-[12px] border px-4 py-3 text-left transition-all cursor-pointer ${
                  mode === entry.id
                    ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
                    : 'bg-bg border-white/[0.06] text-text-2 hover:bg-surface-2'
                }`}
                style={{ fontFamily: 'inherit' }}
              >
                <div className="text-[13px] font-600">{entry.name}</div>
                <div className="text-[11px] text-text-3/70 mt-1">{entry.detail}</div>
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-3">Default Top K</label>
          <input
            type="number"
            min={1}
            max={20}
            value={topK}
            onChange={(e) => {
              const next = Number.parseInt(e.target.value, 10)
              patchSettings({ runtimeSkillTopK: Number.isFinite(next) ? Math.max(1, Math.min(20, next)) : 8 })
            }}
            className={inputClass}
            style={{ fontFamily: 'inherit' }}
          />
          <p className="text-[11px] text-text-3/60 mt-2">
            Applies to `use_skill` and `manage_skills` recommendations when a per-request limit is not supplied.
          </p>
        </div>
      </div>
    </div>
  )
}
