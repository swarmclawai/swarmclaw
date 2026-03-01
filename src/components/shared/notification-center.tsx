'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { useWs } from '@/hooks/use-ws'
import type { AppNotification } from '@/types'

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
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

export function NotificationCenter() {
  const [open, setOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

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
    // If there's an entity, we could navigate - for now just mark as read
    setOpen(false)
  }

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        className="relative flex items-center justify-center w-8 h-8 rounded-[8px] bg-transparent hover:bg-white/[0.05] transition-colors cursor-pointer border-none"
        aria-label="Notifications"
        title={unreadCount > 0 ? `${unreadCount} unread notifications` : 'Notifications'}
      >
        {/* Bell icon */}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-text-2">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {/* Badge */}
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 flex items-center justify-center rounded-full bg-red-500 text-[10px] font-700 text-white px-1 leading-none">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          className="absolute right-0 top-full mt-2 w-[340px] max-h-[460px] bg-raised border border-white/[0.06] rounded-[14px] shadow-[0_16px_64px_rgba(0,0,0,0.6)] backdrop-blur-xl z-90 flex flex-col overflow-hidden"
          style={{ animation: 'fade-in 0.15s cubic-bezier(0.16, 1, 0.3, 1)' }}
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
                        <span className="text-[10px] text-text-3/50 shrink-0">{timeAgo(n.createdAt)}</span>
                      </div>
                      {n.message && (
                        <p className="text-[11px] text-text-3 mt-0.5 leading-relaxed line-clamp-2 m-0">
                          {n.message}
                        </p>
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
      )}
    </div>
  )
}
