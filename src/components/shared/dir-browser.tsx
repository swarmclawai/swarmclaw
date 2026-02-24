'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { api } from '@/lib/api-client'

interface DirEntry {
  name: string
  path: string
}

interface DirApiResponse {
  dirs: DirEntry[]
  currentPath: string
  parentPath: string | null
}

interface DirBrowserProps {
  value: string | null
  file?: string | null
  onChange: (dir: string, file?: string | null) => void
  onClear: () => void
}

type Mode = 'native' | 'browse'

export function DirBrowser({ value, file, onChange, onClear }: DirBrowserProps) {
  const [mode, setMode] = useState<Mode>('native')
  const [picking, setPicking] = useState<'file' | 'folder' | null>(null)

  // Browse mode state
  const [browsePath, setBrowsePath] = useState('~/Dev')
  const [dirs, setDirs] = useState<DirEntry[]>([])
  const [currentPath, setCurrentPath] = useState('')
  const [parentPath, setParentPath] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [pathInput, setPathInput] = useState('')
  const [search, setSearch] = useState('')

  const fetchDirs = useCallback(async (dirPath: string) => {
    setLoading(true)
    try {
      const data = await api<DirApiResponse>('GET', `/dirs?path=${encodeURIComponent(dirPath)}`)
      setDirs(data.dirs || [])
      setCurrentPath(data.currentPath || dirPath)
      setParentPath(data.parentPath || null)
      setPathInput(data.currentPath || dirPath)
    } catch {
      setDirs([])
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    if (mode === 'browse') {
      fetchDirs(browsePath)
      setSearch('')
    }
  }, [browsePath, mode, fetchDirs])

  const filteredDirs = useMemo(() => {
    if (!search) return dirs
    const q = search.toLowerCase()
    return dirs.filter((d) => d.name.toLowerCase().includes(q))
  }, [dirs, search])

  const navigateTo = (path: string) => setBrowsePath(path)

  const handlePathSubmit = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && pathInput.trim()) {
      navigateTo(pathInput.trim())
    }
  }

  const handlePick = async (pickMode: 'file' | 'folder') => {
    setPicking(pickMode)
    try {
      const data = await api<{ directory: string | null; file: string | null }>('POST', '/dirs/pick', { mode: pickMode })
      if (data.directory) {
        onChange(data.directory, data.file)
      }
    } catch { /* cancelled or error */ }
    setPicking(null)
  }

  // Breadcrumbs for browse mode
  const homedir = currentPath.match(/^\/Users\/[^/]+/)?.[0] || ''
  const breadcrumbs: Array<{ label: string; path: string }> = []
  if (currentPath && homedir) {
    const relative = currentPath.slice(homedir.length)
    const parts = relative.split('/').filter(Boolean)
    breadcrumbs.push({ label: '~', path: homedir })
    let acc = homedir
    for (const p of parts) {
      acc = `${acc}/${p}`
      breadcrumbs.push({ label: p, path: acc })
    }
  } else if (currentPath) {
    const parts = currentPath.split('/').filter(Boolean)
    breadcrumbs.push({ label: '/', path: '/' })
    let acc = ''
    for (const p of parts) {
      acc = `${acc}/${p}`
      breadcrumbs.push({ label: p, path: acc })
    }
  }

  // Selected state
  if (value) {
    const displayDir = value.replace(/^\/Users\/\w+/, '~')
    const displayFile = file ? file.split('/').pop() : null
    return (
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0 px-4 py-3 rounded-[14px] border border-accent-bright/20 bg-accent-soft overflow-hidden">
          <div className="text-accent-bright text-[14px] font-mono truncate">{displayDir}</div>
          {displayFile && (
            <div className="text-accent-bright/60 text-[12px] font-mono truncate mt-0.5">
              {displayFile}
            </div>
          )}
        </div>
        <button
          onClick={onClear}
          className="shrink-0 px-3 py-3 rounded-[14px] border border-white/[0.08] bg-surface text-text-3 text-[13px] cursor-pointer hover:bg-surface-2 transition-colors"
          style={{ fontFamily: 'inherit' }}
        >
          Clear
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {mode === 'native' ? (
        <>
          {/* Native picker buttons */}
          <div className="flex gap-3">
            <button
              onClick={() => handlePick('folder')}
              disabled={picking !== null}
              className="flex-1 flex items-center justify-center gap-2.5 py-3.5 rounded-[14px] border border-white/[0.08] bg-surface text-text-2 text-[14px] font-600 cursor-pointer hover:bg-surface-2 hover:border-white/[0.12] transition-all disabled:opacity-40"
              style={{ fontFamily: 'inherit' }}
            >
              {picking === 'folder' ? (
                <span className="text-text-3">Opening...</span>
              ) : (
                <>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" className="text-text-3">
                    <path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2Z" />
                  </svg>
                  Choose Folder
                </>
              )}
            </button>
            <button
              onClick={() => handlePick('file')}
              disabled={picking !== null}
              className="flex-1 flex items-center justify-center gap-2.5 py-3.5 rounded-[14px] border border-white/[0.08] bg-surface text-text-2 text-[14px] font-600 cursor-pointer hover:bg-surface-2 hover:border-white/[0.12] transition-all disabled:opacity-40"
              style={{ fontFamily: 'inherit' }}
            >
              {picking === 'file' ? (
                <span className="text-text-3">Opening...</span>
              ) : (
                <>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-text-3">
                    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                  Choose File
                </>
              )}
            </button>
          </div>
          <button
            onClick={() => setMode('browse')}
            className="text-[12px] text-text-3/60 hover:text-text-3 transition-colors cursor-pointer bg-transparent border-none p-0"
          >
            Or browse directories manually
          </button>
        </>
      ) : (
        <>
          {/* Path input */}
          <input
            type="text"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={handlePathSubmit}
            placeholder="Type a path and press Enter..."
            className="w-full px-4 py-3 rounded-[14px] border border-white/[0.08] bg-surface text-text text-[14px] font-mono outline-none transition-all duration-200 placeholder:text-text-3/50 focus-glow"
          />

          {/* Breadcrumb bar */}
          <div className="flex items-center gap-1 px-1 overflow-x-auto scrollbar-none">
            {parentPath && (
              <button
                onClick={() => navigateTo(parentPath)}
                className="shrink-0 w-7 h-7 rounded-[8px] border border-white/[0.06] bg-surface text-text-3 text-[13px] cursor-pointer hover:bg-surface-2 hover:text-text-2 transition-colors flex items-center justify-center"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 18 9 12 15 6" />
                </svg>
              </button>
            )}
            {breadcrumbs.map((bc, i) => (
              <span key={bc.path} className="flex items-center shrink-0">
                {i > 0 && <span className="text-text-3/60 text-[12px] mx-0.5">/</span>}
                <button
                  onClick={() => navigateTo(bc.path)}
                  className={`px-2 py-1 rounded-[6px] text-[12px] font-600 cursor-pointer transition-colors
                    ${i === breadcrumbs.length - 1
                      ? 'text-text bg-white/[0.04]'
                      : 'text-text-3 hover:text-text-2 hover:bg-white/[0.04]'}`}
                >
                  {bc.label}
                </button>
              </span>
            ))}
          </div>

          {/* Search filter */}
          {dirs.length > 5 && (
            <div className="relative">
              <svg className="absolute left-3.5 top-1/2 -translate-y-1/2 text-text-3/70" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter directories..."
                className="w-full pl-9 pr-4 py-2.5 rounded-[12px] border border-white/[0.06] bg-surface-2 text-text text-[13px] outline-none transition-all duration-200 placeholder:text-text-3/70 focus:border-white/[0.12]"
              />
            </div>
          )}

          {/* Directory list */}
          <div className="max-h-[200px] overflow-y-auto rounded-[14px] border border-white/[0.06] bg-surface divide-y divide-white/[0.04]">
            {loading ? (
              <div className="py-8 text-center text-[13px] text-text-3/50">Loading...</div>
            ) : filteredDirs.length === 0 ? (
              <div className="py-8 text-center text-[13px] text-text-3/50">
                {search ? 'No matching directories' : 'No subdirectories'}
              </div>
            ) : (
              filteredDirs.map((d) => (
                <button
                  key={d.path}
                  onClick={() => navigateTo(d.path)}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left cursor-pointer transition-colors hover:bg-white/[0.03] group"
                >
                  <svg className="shrink-0 text-text-3/70 group-hover:text-accent-bright/60 transition-colors" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2Z" />
                  </svg>
                  <span className="text-[13px] font-600 text-text-2 group-hover:text-text truncate">{d.name}</span>
                  <svg className="shrink-0 ml-auto text-text-3/50 group-hover:text-text-3/70 transition-colors" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </button>
              ))
            )}
          </div>

          {/* Actions */}
          <div className="flex gap-3">
            <button
              onClick={() => onChange(currentPath, null)}
              className="flex-1 py-3 rounded-[14px] border border-accent-bright/20 bg-accent-soft text-accent-bright text-[14px] font-600 cursor-pointer hover:brightness-110 transition-all"
              style={{ fontFamily: 'inherit' }}
            >
              Select This Directory
            </button>
          </div>
          <button
            onClick={() => setMode('native')}
            className="text-[12px] text-text-3/60 hover:text-text-3 transition-colors cursor-pointer bg-transparent border-none p-0"
          >
            Or use system file picker
          </button>
        </>
      )}
    </div>
  )
}
