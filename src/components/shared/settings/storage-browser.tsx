'use client'

import { useState, useMemo } from 'react'
import { ConfirmDialog } from '@/components/shared/confirm-dialog'

interface UploadFile {
  name: string
  size: number
  modified: number
  category: string
  url: string
}

type SortField = 'modified' | 'size' | 'name'

interface Props {
  files: UploadFile[]
  onDelete: (filenames: string[]) => void
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / Math.pow(1024, i)
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`
}

function formatDate(ms: number): string {
  const d = new Date(ms)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

const CATEGORY_ICONS: Record<string, string> = {
  image: '\u{1F5BC}',
  video: '\u{1F3AC}',
  audio: '\u{1F3B5}',
  document: '\u{1F4C4}',
  archive: '\u{1F4E6}',
  other: '\u{1F4CE}',
}

const CATEGORY_LABELS: Record<string, string> = {
  image: 'Images',
  video: 'Videos',
  audio: 'Audio',
  document: 'Docs',
  archive: 'Archives',
  other: 'Other',
}

export function StorageBrowser({ files, onDelete }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [sortBy, setSortBy] = useState<SortField>('modified')
  const [filterCategory, setFilterCategory] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null)

  const categories = useMemo(() => {
    const cats = new Set<string>()
    for (const f of files) cats.add(f.category)
    return Array.from(cats).sort()
  }, [files])

  const filtered = useMemo(() => {
    let list = filterCategory ? files.filter((f) => f.category === filterCategory) : files
    list = [...list].sort((a, b) => {
      if (sortBy === 'modified') return b.modified - a.modified
      if (sortBy === 'size') return b.size - a.size
      return a.name.localeCompare(b.name)
    })
    return list
  }, [files, filterCategory, sortBy])

  const totalSize = useMemo(() => files.reduce((s, f) => s + f.size, 0), [files])

  const toggleSelect = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (selected.size === filtered.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(filtered.map((f) => f.name)))
    }
  }

  const handleDeleteSelected = () => {
    const names = Array.from(selected)
    if (names.length > 0) setConfirmDelete(names)
  }

  const executeDelete = () => {
    if (confirmDelete) {
      onDelete(confirmDelete)
      setSelected((prev) => {
        const next = new Set(prev)
        for (const name of confirmDelete) next.delete(name)
        return next
      })
      setConfirmDelete(null)
    }
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h3 className="font-display text-[18px] font-700 tracking-[-0.02em] text-text">File Browser</h3>
          <p className="text-[12px] text-text-3 mt-0.5">
            {files.length} file{files.length !== 1 ? 's' : ''} &middot; {formatBytes(totalSize)}
          </p>
        </div>
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as SortField)}
          className="px-3 py-1.5 rounded-[10px] border border-white/[0.08] bg-bg text-text text-[12px] outline-none cursor-pointer"
          style={{ fontFamily: 'inherit' }}
        >
          <option value="modified">Newest first</option>
          <option value="size">Largest first</option>
          <option value="name">Name A-Z</option>
        </select>
      </div>

      {/* Category filters */}
      <div className="flex gap-1.5 mb-4 flex-wrap">
        <button
          onClick={() => setFilterCategory(null)}
          className={`px-3 py-1 rounded-full text-[11px] font-600 cursor-pointer transition-all border
            ${!filterCategory
              ? 'bg-accent-soft border-accent-bright/30 text-accent-bright'
              : 'bg-transparent border-white/[0.06] text-text-3 hover:bg-white/[0.04]'}`}
          style={{ fontFamily: 'inherit' }}
        >
          All
        </button>
        {categories.map((cat) => (
          <button
            key={cat}
            onClick={() => setFilterCategory(filterCategory === cat ? null : cat)}
            className={`px-3 py-1 rounded-full text-[11px] font-600 cursor-pointer transition-all border
              ${filterCategory === cat
                ? 'bg-accent-soft border-accent-bright/30 text-accent-bright'
                : 'bg-transparent border-white/[0.06] text-text-3 hover:bg-white/[0.04]'}`}
            style={{ fontFamily: 'inherit' }}
          >
            {CATEGORY_ICONS[cat] || ''} {CATEGORY_LABELS[cat] || cat}
          </button>
        ))}
      </div>

      {/* Select all */}
      {filtered.length > 0 && (
        <div className="flex items-center gap-2 mb-3">
          <button
            onClick={toggleSelectAll}
            className="text-[11px] text-accent-bright hover:underline cursor-pointer bg-transparent border-none"
            style={{ fontFamily: 'inherit' }}
          >
            {selected.size === filtered.length ? 'Deselect all' : 'Select all'}
          </button>
          {selected.size > 0 && (
            <span className="text-[11px] text-text-3">
              {selected.size} selected
            </span>
          )}
        </div>
      )}

      {/* File grid */}
      {filtered.length === 0 ? (
        <div className="py-12 text-center text-[13px] text-text-3/60">
          {files.length === 0 ? 'No uploaded files.' : 'No files match this filter.'}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-[400px] overflow-y-auto pr-1">
          {filtered.map((file) => (
            <div
              key={file.name}
              onClick={() => toggleSelect(file.name)}
              className={`relative p-3 rounded-[14px] border cursor-pointer transition-all
                ${selected.has(file.name)
                  ? 'border-accent-bright/40 bg-accent-soft/30'
                  : 'border-white/[0.06] bg-surface hover:border-white/[0.12]'}`}
            >
              {/* Checkbox */}
              <div className={`absolute top-2 right-2 w-4 h-4 rounded-[5px] border transition-all flex items-center justify-center
                ${selected.has(file.name)
                  ? 'border-accent-bright bg-accent-bright'
                  : 'border-white/[0.15] bg-transparent'}`}
              >
                {selected.has(file.name) && (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </div>

              {/* Thumbnail / icon */}
              <div className="w-full aspect-square rounded-[10px] bg-white/[0.03] mb-2 flex items-center justify-center overflow-hidden">
                {file.category === 'image' ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={file.url}
                    alt={file.name}
                    className="w-full h-full object-cover rounded-[10px]"
                    loading="lazy"
                  />
                ) : (
                  <span className="text-[28px]">{CATEGORY_ICONS[file.category] || CATEGORY_ICONS.other}</span>
                )}
              </div>

              {/* Meta */}
              <p className="text-[11px] font-600 text-text truncate" title={file.name}>{file.name}</p>
              <p className="text-[10px] text-text-3/60 mt-0.5">
                {formatBytes(file.size)} &middot; {formatDate(file.modified)}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Bulk delete footer */}
      {selected.size > 0 && (
        <div className="mt-4 pt-4 border-t border-white/[0.06] flex items-center justify-between">
          <span className="text-[12px] text-text-3">
            {selected.size} file{selected.size !== 1 ? 's' : ''} selected
          </span>
          <button
            onClick={handleDeleteSelected}
            className="px-4 py-2 rounded-[10px] bg-danger text-white text-[12px] font-600 cursor-pointer
              hover:brightness-110 active:scale-[0.97] transition-all border-none"
            style={{ fontFamily: 'inherit' }}
          >
            Delete Selected
          </button>
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete Files"
        message={`Permanently delete ${confirmDelete?.length ?? 0} file${(confirmDelete?.length ?? 0) !== 1 ? 's' : ''}? This cannot be undone.`}
        confirmLabel="Delete"
        danger
        onConfirm={executeDelete}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  )
}
