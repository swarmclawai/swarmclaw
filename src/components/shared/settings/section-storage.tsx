'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api-client'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import { ConfirmDialog } from '@/components/shared/confirm-dialog'
import { StorageBrowser } from './storage-browser'
import type { SettingsSectionProps } from './types'

interface UploadFile {
  name: string
  size: number
  modified: number
  category: string
  url: string
}

interface UploadsResponse {
  files: UploadFile[]
  totalSize: number
  count: number
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / Math.pow(1024, i)
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`
}

export function StorageSection(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _props: SettingsSectionProps,
) {
  const [data, setData] = useState<UploadsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [browserOpen, setBrowserOpen] = useState(false)
  const [confirmAction, setConfirmAction] = useState<'clearOld' | 'clearAll' | null>(null)
  const [deleting, setDeleting] = useState(false)

  const fetchFiles = useCallback(async () => {
    try {
      setLoading(true)
      const res = await api<UploadsResponse>('GET', '/uploads')
      setData(res)
    } catch {
      // silent — section just shows empty
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchFiles()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleBulkDelete = useCallback(async (filenames: string[]) => {
    try {
      await api('DELETE', '/uploads', { filenames })
      await fetchFiles()
    } catch {
      // silent
    }
  }, [fetchFiles])

  const handleConfirmAction = useCallback(async () => {
    if (!confirmAction) return
    setDeleting(true)
    try {
      if (confirmAction === 'clearOld') {
        await api('DELETE', '/uploads', { olderThanDays: 30 })
      } else {
        await api('DELETE', '/uploads', { all: true })
      }
      await fetchFiles()
    } catch {
      // silent
    } finally {
      setDeleting(false)
      setConfirmAction(null)
    }
  }, [confirmAction, fetchFiles])

  // Breakdown by category
  const breakdown = data?.files.reduce<Record<string, { count: number; size: number }>>((acc, f) => {
    if (!acc[f.category]) acc[f.category] = { count: 0, size: 0 }
    acc[f.category].count += 1
    acc[f.category].size += f.size
    return acc
  }, {}) ?? {}

  const CATEGORY_LABELS: Record<string, string> = {
    image: 'Images',
    video: 'Videos',
    audio: 'Audio',
    document: 'Documents',
    archive: 'Archives',
    other: 'Other',
  }

  return (
    <div className="mb-10">
      <h3 className="font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
        Storage
      </h3>
      <p className="text-[12px] text-text-3 mb-5">
        Uploaded files from agent tools (screenshots, images, documents). Manage disk usage.
      </p>

      <div className="p-6 rounded-[18px] bg-surface border border-white/[0.06]">
        {/* Summary */}
        {loading ? (
          <div className="text-[13px] text-text-3/60 animate-pulse">Loading storage info...</div>
        ) : (
          <>
            <div className="flex items-baseline gap-3 mb-4">
              <span className="font-display text-[28px] font-700 tracking-[-0.02em] text-text">
                {formatBytes(data?.totalSize ?? 0)}
              </span>
              <span className="text-[13px] text-text-3">
                {data?.count ?? 0} file{data?.count !== 1 ? 's' : ''}
              </span>
            </div>

            {/* Category breakdown */}
            {Object.keys(breakdown).length > 0 && (
              <div className="flex flex-wrap gap-x-4 gap-y-1 mb-5">
                {Object.entries(breakdown).map(([cat, info]) => (
                  <span key={cat} className="text-[11px] text-text-3/70">
                    {CATEGORY_LABELS[cat] || cat}: {info.count} ({formatBytes(info.size)})
                  </span>
                ))}
              </div>
            )}

            {/* Actions */}
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setBrowserOpen(true)}
                disabled={!data?.count}
                className="px-4 py-2.5 rounded-[12px] bg-accent-soft text-accent-bright text-[12px] font-600 cursor-pointer
                  hover:brightness-110 active:scale-[0.97] transition-all border border-accent-bright/20
                  disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ fontFamily: 'inherit' }}
              >
                Manage Files
              </button>
              <button
                onClick={() => setConfirmAction('clearOld')}
                disabled={!data?.count}
                className="px-4 py-2.5 rounded-[12px] bg-white/[0.04] text-text-2 text-[12px] font-600 cursor-pointer
                  hover:bg-white/[0.06] active:scale-[0.97] transition-all border border-white/[0.06]
                  disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ fontFamily: 'inherit' }}
              >
                Clear Old Files
              </button>
              <button
                onClick={() => setConfirmAction('clearAll')}
                disabled={!data?.count}
                className="px-4 py-2.5 rounded-[12px] bg-danger/10 text-danger text-[12px] font-600 cursor-pointer
                  hover:bg-danger/20 active:scale-[0.97] transition-all border border-danger/20
                  disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ fontFamily: 'inherit' }}
              >
                Clear All
              </button>
            </div>
          </>
        )}
      </div>

      {/* File browser sheet */}
      <BottomSheet open={browserOpen} onClose={() => setBrowserOpen(false)} wide>
        {data && (
          <StorageBrowser
            files={data.files}
            onDelete={handleBulkDelete}
          />
        )}
      </BottomSheet>

      {/* Confirm dialogs */}
      <ConfirmDialog
        open={confirmAction === 'clearOld'}
        title="Clear Old Files"
        message="Delete all uploaded files older than 30 days? This cannot be undone."
        confirmLabel={deleting ? 'Deleting...' : 'Delete Old Files'}
        danger
        onConfirm={handleConfirmAction}
        onCancel={() => setConfirmAction(null)}
      />
      <ConfirmDialog
        open={confirmAction === 'clearAll'}
        title="Clear All Files"
        message="Delete ALL uploaded files? This will free up all storage but cannot be undone."
        confirmLabel={deleting ? 'Deleting...' : 'Delete All'}
        danger
        onConfirm={handleConfirmAction}
        onCancel={() => setConfirmAction(null)}
      />
    </div>
  )
}
