'use client'

import type { SettingsSectionProps } from './types'

export function MemorySection({ appSettings, patchSettings, inputClass }: SettingsSectionProps) {
  return (
    <div className="mb-10">
      <h3 className="font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
        Memory Retrieval
      </h3>
      <p className="text-[12px] text-text-3 mb-5">
        Guardrails for memory graph traversal and lookup fan-out. These limits are enforced server-side.
      </p>
      <div className="p-6 rounded-[18px] bg-surface border border-white/[0.06]">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">
              Reference Depth
            </label>
            <input
              type="number"
              min={0}
              max={12}
              value={appSettings.memoryReferenceDepth ?? appSettings.memoryMaxDepth ?? 3}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10)
                const depth = Number.isFinite(n) ? Math.max(0, Math.min(12, n)) : 3
                patchSettings({ memoryReferenceDepth: depth, memoryMaxDepth: depth })
              }}
              className={inputClass}
              style={{ fontFamily: 'inherit' }}
            />
            <p className="text-[11px] text-text-3/60 mt-2">How far linked memory traversal can go.</p>
          </div>
          <div>
            <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">
              Max Per Lookup
            </label>
            <input
              type="number"
              min={1}
              max={200}
              value={appSettings.maxMemoriesPerLookup ?? appSettings.memoryMaxPerLookup ?? 20}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10)
                const perLookup = Number.isFinite(n) ? Math.max(1, Math.min(200, n)) : 20
                patchSettings({ maxMemoriesPerLookup: perLookup, memoryMaxPerLookup: perLookup })
              }}
              className={inputClass}
              style={{ fontFamily: 'inherit' }}
            />
            <p className="text-[11px] text-text-3/60 mt-2">Total memories returned in one retrieval call.</p>
          </div>
          <div>
            <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">
              Max Linked Expansion
            </label>
            <input
              type="number"
              min={0}
              max={1000}
              value={appSettings.maxLinkedMemoriesExpanded ?? 60}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10)
                const linked = Number.isFinite(n) ? Math.max(0, Math.min(1000, n)) : 60
                patchSettings({ maxLinkedMemoriesExpanded: linked })
              }}
              className={inputClass}
              style={{ fontFamily: 'inherit' }}
            />
            <p className="text-[11px] text-text-3/60 mt-2">Caps how many linked nodes can be expanded per lookup.</p>
          </div>
        </div>
      </div>
    </div>
  )
}
