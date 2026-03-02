'use client'

import { useState, useMemo } from 'react'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import { SOUL_LIBRARY, SOUL_ARCHETYPES, searchSouls, type SoulTemplate } from '@/lib/soul-library'

interface SoulLibraryPickerProps {
  open: boolean
  onClose: () => void
  onSelect: (soul: string) => void
}

export function SoulLibraryPicker({ open, onClose, onSelect }: SoulLibraryPickerProps) {
  const [query, setQuery] = useState('')
  const [archetype, setArchetype] = useState('All')

  const results = useMemo(() => searchSouls(query, archetype), [query, archetype])

  const handleSelect = (template: SoulTemplate) => {
    onSelect(template.soul)
    onClose()
  }

  return (
    <BottomSheet open={open} onClose={onClose}>
      <div className="mb-6">
        <h2 className="font-display text-[24px] font-700 tracking-[-0.03em] mb-1">Soul Library</h2>
        <p className="text-[13px] text-text-3">Browse personality templates for your agent</p>
      </div>

      {/* Search */}
      <div className="mb-4">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search personalities..."
          className="w-full px-4 py-3 rounded-[14px] border border-white/[0.08] bg-surface text-text text-[14px] outline-none focus-glow"
          style={{ fontFamily: 'inherit' }}
        />
      </div>

      {/* Archetype filter tabs */}
      <div className="flex gap-1 flex-wrap mb-6">
        {SOUL_ARCHETYPES.map((a) => (
          <button
            key={a}
            onClick={() => setArchetype(a)}
            className={`px-3 py-1.5 rounded-[8px] text-[12px] font-600 cursor-pointer transition-all border
              ${archetype === a
                ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
                : 'bg-surface border-white/[0.06] text-text-3 hover:text-text-2'}`}
            style={{ fontFamily: 'inherit' }}
          >
            {a}
          </button>
        ))}
      </div>

      {/* Results grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[60vh] overflow-y-auto pb-4">
        {results.map((template) => (
          <button
            key={template.id}
            onClick={() => handleSelect(template)}
            className="text-left p-4 rounded-[14px] border border-white/[0.06] bg-surface hover:bg-surface-2 hover:border-accent-bright/20 transition-all cursor-pointer group"
            style={{ fontFamily: 'inherit' }}
          >
            <div className="flex items-start gap-2 mb-2">
              <h4 className="text-[14px] font-600 text-text group-hover:text-accent-bright transition-colors">
                {template.name}
              </h4>
              <span className="px-1.5 py-0.5 rounded-[5px] bg-white/[0.06] text-text-3 text-[10px] font-600 shrink-0">
                {template.archetype}
              </span>
            </div>
            <p className="text-[12px] text-text-3 mb-2">{template.description}</p>
            <p className="text-[11px] text-text-3/60 line-clamp-2 italic">{template.soul}</p>
          </button>
        ))}
        {results.length === 0 && (
          <p className="text-[13px] text-text-3 col-span-2 text-center py-8">No personalities match your search</p>
        )}
      </div>

      <p className="text-[11px] text-text-3/50 mt-4 text-center">{SOUL_LIBRARY.length} personalities available</p>
    </BottomSheet>
  )
}
