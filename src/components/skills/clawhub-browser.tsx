'use client'

import { useState, useEffect, useCallback } from 'react'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { api } from '@/lib/api-client'
import { toast } from 'sonner'

interface ClawHubSkill {
  id: string
  name: string
  description: string
  author: string
  tags: string[]
  downloads: number
  url: string
  version: string
}

interface SearchResponse {
  skills: ClawHubSkill[]
  total: number
  page: number
}

interface ClawHubBrowserProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onInstalled?: () => void
}

export function ClawHubBrowser({ open, onOpenChange, onInstalled }: ClawHubBrowserProps) {
  const [query, setQuery] = useState('')
  const [skills, setSkills] = useState<ClawHubSkill[]>([])
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [installing, setInstalling] = useState<string | null>(null)
  const [searched, setSearched] = useState(false)

  const search = useCallback(async (q: string, p: number, append = false) => {
    setLoading(true)
    setError(null)
    try {
      const res = await api<SearchResponse>('GET', `/clawhub/search?q=${encodeURIComponent(q)}&page=${p}`)
      if (append) {
        setSkills(prev => [...prev, ...res.skills])
      } else {
        setSkills(res.skills)
      }
      setTotal(res.total)
      setPage(res.page)
      setSearched(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to search ClawHub')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) {
      setQuery('')
      setSkills([])
      setPage(1)
      setTotal(0)
      setError(null)
      setSearched(false)
      search('', 1)
    }
  }, [open, search])

  const handleSearch = () => {
    setSkills([])
    search(query, 1)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch()
  }

  const handleLoadMore = () => {
    search(query, page + 1, true)
  }

  const handleInstall = async (skill: ClawHubSkill) => {
    setInstalling(skill.id)
    try {
      await api('POST', '/clawhub/install', {
        name: skill.name,
        description: skill.description,
        url: skill.url,
        tags: skill.tags,
      })
      toast.success(`Installed "${skill.name}"`)
      onInstalled?.()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Install failed')
    } finally {
      setInstalling(null)
    }
  }

  const hasMore = skills.length < total

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-lg flex flex-col">
        <SheetHeader>
          <SheetTitle className="font-display text-[16px] font-600 text-text">
            ClawHub
          </SheetTitle>
          <p className="text-[12px] text-text-3/60">Browse and install community skills</p>
        </SheetHeader>

        <div className="flex gap-2 px-4">
          <Input
            placeholder="Search skills..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 text-[13px]"
          />
          <Button size="sm" onClick={handleSearch} disabled={loading}>
            Search
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-4">
          {error && (
            <div className="text-center py-12">
              <p className="text-[13px] text-red-400">{error}</p>
              <Button size="sm" variant="ghost" className="mt-2" onClick={() => search(query, 1)}>
                Retry
              </Button>
            </div>
          )}

          {!error && !loading && searched && skills.length === 0 && (
            <div className="text-center py-12">
              <p className="text-[13px] text-text-3/60">No skills found</p>
              {query && (
                <p className="text-[11px] text-text-3/40 mt-1">Try a different search term</p>
              )}
            </div>
          )}

          {skills.length > 0 && (
            <div className="space-y-2">
              {skills.map((skill) => (
                <div
                  key={skill.id}
                  className="p-4 rounded-[14px] border border-white/[0.06] bg-surface hover:bg-surface-2 transition-all"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="font-display text-[14px] font-600 text-text truncate">
                          {skill.name}
                        </span>
                        <span className="text-[10px] font-mono text-text-3/40 shrink-0">
                          v{skill.version}
                        </span>
                      </div>
                      <p className="text-[12px] text-text-3/60 line-clamp-2 mb-2">
                        {skill.description}
                      </p>
                      <div className="flex items-center gap-2 flex-wrap">
                        {skill.tags.slice(0, 4).map((tag) => (
                          <Badge
                            key={tag}
                            variant="secondary"
                            className="text-[10px] px-1.5 py-0"
                          >
                            {tag}
                          </Badge>
                        ))}
                      </div>
                      <div className="flex items-center gap-3 mt-2 text-[11px] text-text-3/50">
                        <span>{skill.author}</span>
                        <span>{skill.downloads.toLocaleString()} installs</span>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="shrink-0 text-[12px]"
                      disabled={installing === skill.id}
                      onClick={() => handleInstall(skill)}
                    >
                      {installing === skill.id ? 'Installing...' : 'Install'}
                    </Button>
                  </div>
                </div>
              ))}

              {hasMore && (
                <div className="pt-2 pb-4 text-center">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={handleLoadMore}
                    disabled={loading}
                    className="text-[12px] text-text-3/60"
                  >
                    {loading ? 'Loading...' : 'Load More'}
                  </Button>
                </div>
              )}
            </div>
          )}

          {loading && skills.length === 0 && (
            <div className="flex items-center justify-center py-12">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-text-3/20 border-t-text-3/60" />
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
