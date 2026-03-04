'use client'

import { useState, useMemo, useEffect } from 'react'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import { SOUL_LIBRARY, SOUL_ARCHETYPES, searchSouls, type SoulTemplate } from '@/lib/soul-library'
import { api } from '@/lib/api-client'

interface SoulLibraryPickerProps {
  open: boolean
  onClose: () => void
  onSelect: (soul: string) => void
}

export function SoulLibraryPicker({ open, onClose, onSelect }: SoulLibraryPickerProps) {
  const [query, setQuery] = useState('')
  const [archetype, setArchetype] = useState('All')
  const [source, setSource] = useState<'library' | 'forge'>('library')
  const [customSouls, setCustomSouls] = useState<SoulTemplate[]>([])
  const [loading, setLoading] = useState(false)

  const results = useMemo(() => {
    if (source === 'library') {
      return searchSouls(query, archetype)
    } else {
      let filtered = customSouls
      if (archetype && archetype !== 'All') {
        filtered = filtered.filter(s => s.archetype === archetype)
      }
      if (query) {
        const q = query.toLowerCase()
        filtered = filtered.filter(s => 
          s.name.toLowerCase().includes(q) || 
          s.soul.toLowerCase().includes(q) ||
          s.tags.some(t => t.toLowerCase().includes(q))
        )
      }
      return filtered
    }
  }, [query, archetype, source, customSouls])

  useEffect(() => {
    if (open && source === 'forge') {
      const load = async () => {
        setLoading(true)
        try {
          const res = await api<SoulTemplate[]>('GET', '/souls')
          // Filter out the built-in ones from the API result since we show them in 'library' tab
          const libraryIds = new Set(SOUL_LIBRARY.map(s => s.id))
          setCustomSouls(res.filter(s => !libraryIds.has(s.id)))
        } catch (err) {
          console.error('Failed to load custom souls', err)
        } finally {
          setLoading(false)
        }
      }
      load()
    }
  }, [open, source])

  const handleSelect = (template: SoulTemplate) => {
    onSelect(template.soul)
    onClose()
  }

  return (
    <BottomSheet open={open} onClose={onClose}>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="font-display text-[24px] font-700 tracking-[-0.03em] mb-1">Soul Library</h2>
          <p className="text-[13px] text-text-3">Browse personality templates for your agent</p>
        </div>
        <div className="flex bg-white/[0.04] p-1 rounded-[12px] border border-white/[0.04]">
           <button 
             onClick={() => setSource('library')}
             className={`px-3 py-1.5 rounded-[10px] text-[12px] font-600 transition-all ${source === 'library' ? 'bg-white/[0.08] text-text shadow-sm' : 'text-text-3 hover:text-text-2'}`}
           >
             Verified
           </button>
           <button 
             onClick={() => setSource('forge')}
             className={`px-3 py-1.5 rounded-[10px] text-[12px] font-600 transition-all ${source === 'forge' ? 'bg-accent-soft text-accent-bright' : 'text-text-3 hover:text-text-2'}`}
           >
             SwarmForge
           </button>
        </div>
      </div>

      {/* Search */}
      <div className="mb-4">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={source === 'library' ? "Search verified personalities..." : "Search SwarmForge / Custom..."}
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
        {loading ? (
          <div className="col-span-2 py-12 flex flex-col items-center gap-3">
             <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-accent-bright" />
             <p className="text-[13px] text-text-3">Stoking the forge...</p>
          </div>
        ) : results.map((template) => (
          <button
            key={template.id}
            onClick={() => handleSelect(template)}
            className={`text-left p-4 rounded-[14px] border border-white/[0.06] bg-surface hover:bg-surface-2 transition-all cursor-pointer group 
              ${source === 'forge' ? 'hover:border-accent-bright/20' : 'hover:border-white/[0.12]'}`}
            style={{ fontFamily: 'inherit' }}
          >
            <div className="flex items-start gap-2 mb-2">
              <h4 className={`text-[14px] font-600 text-text transition-colors ${source === 'forge' ? 'group-hover:text-accent-bright' : ''}`}>
                {template.name}
              </h4>
              <span className="px-1.5 py-0.5 rounded-[5px] bg-white/[0.06] text-text-3 text-[10px] font-600 shrink-0">
                {template.archetype}
              </span>
            </div>
            <p className="text-[12px] text-text-3 mb-2 line-clamp-2">{template.description}</p>
            <p className="text-[11px] text-text-3/60 line-clamp-2 italic">{template.soul}</p>
          </button>
        ))}
        {!loading && results.length === 0 && (
          <div className="col-span-2 text-center py-12">
             <div className="w-12 h-12 rounded-full bg-white/[0.03] flex items-center justify-center mx-auto mb-3">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-text-3/40"><path d="M12 2a4 4 0 0 1 4 4v2a4 4 0 0 1-8 0V6a4 4 0 0 1 4-4Z"/><path d="M16 14H8a4 4 0 0 0-4 4v2h16v-2a4 4 0 0 0-4-4Z"/></svg>
             </div>
             <p className="text-[14px] font-600 text-text-2">No personalities match</p>
             <p className="text-[12px] text-text-3/50 mt-1">{source === 'forge' ? 'Be the first to forge a custom soul in this category!' : 'Try a different search term.'}</p>
          </div>
        )}
      </div>

      <p className="text-[11px] text-text-3/50 mt-4 text-center">
        {source === 'library' ? `${SOUL_LIBRARY.length} verified templates` : `${customSouls.length} custom souls in your forge`}
      </p>
    </BottomSheet>
  )
}
