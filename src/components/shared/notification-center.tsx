'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { useNow } from '@/hooks/use-now'
import { useWs } from '@/hooks/use-ws'
import { getNotificationActivityAt, getNotificationOccurrenceCount } from '@/lib/notification-utils'
import type { AppNotification } from '@/types'

function timeAgo(ts: number, now: number | null): string {
  if (!now) return 'recently'
  const diff = now - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

const TYPE_COLORS: Record<AppNotification['type'], string> = {
  info: 'border-l-blue-400',
  success: 'border-l-emerald-400',
  warning: 'border-l-amber-400',
  error: 'border-l-red-400',
}

const TYPE_ICONS: Record<AppNotification['type'], string> = {
  info: 'i',
  success: '\u2713',
  warning: '!',
  error: '\u2717',
}

const TYPE_ICON_COLORS: Record<AppNotification['type'], string> = {
  info: 'text-blue-400',
  success: 'text-emerald-400',
  warning: 'text-amber-400',
  error: 'text-red-400',
}

const PANEL_WIDTH = 340
const PANEL_MARGIN = 8

function resolveHttpUrl(raw: string | undefined): string | null {
  if (!raw) return null
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null
  } catch {
    return null
  }
}

export function NotificationCenter({
  variant = 'icon',
  align = 'right',
  direction = 'down',
}: {
  variant?: 'icon' | 'row'
  align?: 'left' | 'right'
  direction?: 'up' | 'down'
}) {
  const now = useNow()
  const [open, setOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({
    left: PANEL_MARGIN,
    top: PANEL_MARGIN,
  })

  const notifications = useAppStore((s) => s.notifications)
  const unreadCount = useAppStore((s) => s.unreadNotificationCount)
  const loadNotifications = useAppStore((s) => s.loadNotifications)
  const markRead = useAppStore((s) => s.markNotificationRead)
  const markAllRead = useAppStore((s) => s.markAllNotificationsRead)
  const clearRead = useAppStore((s) => s.clearReadNotifications)

  useEffect(() => {
    loadNotifications()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleWsNotification = useCallback(() => {
    loadNotifications()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useWs('notifications', handleWsNotification, 30_000)

  // Close panel when clicking outside
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const handleNotificationClick = (n: AppNotification) => {
    if (!n.read) {
      markRead(n.id)
    }
    const actionUrl = resolveHttpUrl(n.actionUrl)
    if (actionUrl) {
      window.open(actionUrl, '_blank', 'noopener,noreferrer')
    }
    setOpen(false)
  }

  const isRow = variant === 'row'

  const updatePanelPosition = useCallback(() => {
    if (typeof window === 'undefined' || !buttonRef.current) return

    const rect = buttonRef.current.getBoundingClientRect()
    const maxLeft = Math.max(PANEL_MARGIN, window.innerWidth - PANEL_WIDTH - PANEL_MARGIN)
    const preferredLeft = align === 'left' ? rect.left : rect.right - PANEL_WIDTH
    const clampedLeft = Math.max(PANEL_MARGIN, Math.min(preferredLeft, maxLeft))

    if (direction === 'up') {
      setPanelStyle({
        left: clampedLeft,
        bottom: Math.max(PANEL_MARGIN, window.innerHeight - rect.top + PANEL_MARGIN),
        top: undefined,
      })
      return
    }

    setPanelStyle({
      left: clampedLeft,
      top: Math.max(PANEL_MARGIN, rect.bottom + PANEL_MARGIN),
      bottom: undefined,
    })
  }, [align, direction])

  useEffect(() => {
    if (!open) return
    updatePanelPosition()

    const handler = () => updatePanelPosition()
    window.addEventListener('resize', handler)
    window.addEventListener('scroll', handler, true)
    return () => {
      window.removeEventListener('resize', handler)
      window.removeEventListener('scroll', handler, true)
    }
  }, [open, updatePanelPosition])

  const panelNode = open ? (
    <div
      ref={panelRef}
      className="fixed w-[340px] max-h-[460px] bg-raised border border-white/[0.06] rounded-[14px] shadow-[0_16px_64px_rgba(0,0,0,0.6)] backdrop-blur-xl z-[1200] flex flex-col overflow-hidden"
      style={{
        ...panelStyle,
        animation: 'fade-in 0.15s cubic-bezier(0.16, 1, 0.3, 1)',
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.04] shrink-0">
        <span className="text-[13px] font-600 text-text">Notifications</span>
        <div className="flex items-center gap-2">
          {unreadCount > 0 && (
            <button
              onClick={markAllRead}
              className="text-[11px] font-500 text-text-3 hover:text-text cursor-pointer bg-transparent border-none transition-colors"
              style={{ fontFamily: 'inherit' }}
            >
              Mark all read
            </button>
          )}
          {notifications.some((n) => n.read) && (
            <button
              onClick={clearRead}
              className="text-[11px] font-500 text-text-3 hover:text-text cursor-pointer bg-transparent border-none transition-colors"
              style={{ fontFamily: 'inherit' }}
            >
              Clear read
            </button>
          )}
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {notifications.length === 0 ? (
          <div className="flex items-center justify-center py-10 text-[13px] text-text-3/50">
            No notifications
          </div>
        ) : (
          notifications.map((n) => (
            <button
              key={n.id}
              onClick={() => handleNotificationClick(n)}
              className={`w-full text-left px-4 py-3 border-l-[3px] border-b border-b-white/[0.03] bg-transparent
                hover:bg-white/[0.03] transition-colors cursor-pointer border-t-0 border-r-0
                ${TYPE_COLORS[n.type]}
                ${n.read ? 'opacity-50' : ''}`}
              style={{ fontFamily: 'inherit' }}
            >
              <div className="flex items-start gap-2.5">
                <span className={`text-[12px] font-700 mt-0.5 shrink-0 w-4 text-center ${TYPE_ICON_COLORS[n.type]}`}>
                  {TYPE_ICONS[n.type]}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] font-600 text-text truncate flex-1">{n.title}</span>
                    {getNotificationOccurrenceCount(n) > 1 && (
                      <span className="shrink-0 rounded-full border border-white/[0.08] bg-white/[0.04] px-1.5 py-0.5 text-[9px] font-600 text-text-3/80">
                        x{getNotificationOccurrenceCount(n)}
                      </span>
                    )}
                    <span className="text-[10px] text-text-3/50 shrink-0">{timeAgo(getNotificationActivityAt(n), now)}</span>
                  </div>
                  {n.message && (
                    <p className="text-[11px] text-text-3 mt-0.5 leading-relaxed line-clamp-2 m-0">
                      {n.message}
                    </p>
                  )}
                  {resolveHttpUrl(n.actionUrl) && (
                    <span className="inline-block mt-1 text-[11px] text-accent-bright/90">
                      {n.actionLabel || 'Open link'}
                    </span>
                  )}
                  {n.entityType && (
                    <span className="inline-block mt-1 text-[10px] text-text-3/40 font-mono">
                      {n.entityType}{n.entityId ? `:${n.entityId.slice(0, 8)}` : ''}
                    </span>
                  )}
                </div>
                {!n.read && (
                  <span className="w-2 h-2 rounded-full bg-blue-400 mt-1.5 shrink-0" />
                )}
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  ) : null

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        className={
          isRow
            ? 'relative w-full flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-[13px] font-500 cursor-pointer transition-all bg-transparent text-text-3 hover:text-text hover:bg-white/[0.04] border-none'
            : 'relative flex items-center justify-center w-8 h-8 rounded-[8px] bg-transparent hover:bg-white/[0.05] transition-colors cursor-pointer border-none'
        }
        aria-label="Notifications"
        title={unreadCount > 0 ? `${unreadCount} unread notifications` : 'Notifications'}
      >
        {/* Bell icon */}
        <svg width={isRow ? '16' : '16'} height={isRow ? '16' : '16'} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={isRow ? 'text-text-3 shrink-0' : 'text-text-2'}>
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {isRow && <span className="text-[13px] font-500">Notifications</span>}
        {/* Badge */}
        {unreadCount > 0 && (
          <span className={isRow
            ? 'ml-auto min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-red-500 text-[10px] font-700 text-white px-1 leading-none'
            : 'absolute -top-0.5 -right-0.5 min-w-[16px] h-4 flex items-center justify-center rounded-full bg-red-500 text-[10px] font-700 text-white px-1 leading-none'}
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>
      {panelNode && typeof document !== 'undefined' ? createPortal(panelNode, document.body) : panelNode}
    </div>
  )
}
