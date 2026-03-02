'use client'

import { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'

interface Shortcut {
  keys: string[]
  description: string
}

interface ShortcutGroup {
  title: string
  shortcuts: Shortcut[]
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.userAgent)
const MOD = isMac ? '\u2318' : 'Ctrl'

const GROUPS: ShortcutGroup[] = [
  {
    title: 'Navigation',
    shortcuts: [
      { keys: [MOD, 'K'], description: 'Open search' },
      { keys: [MOD, 'Shift', 'A'], description: 'Switch agent' },
      { keys: [MOD, 'N'], description: 'New chat' },
      { keys: [MOD, 'Shift', 'T'], description: 'Jump to tasks' },
    ],
  },
  {
    title: 'Chat',
    shortcuts: [
      { keys: ['Enter'], description: 'Send message' },
      { keys: ['Shift', 'Enter'], description: 'New line' },
      { keys: ['Esc'], description: 'Cancel reply / close' },
    ],
  },
  {
    title: 'General',
    shortcuts: [
      { keys: ['?'], description: 'Show keyboard shortcuts' },
    ],
  },
]

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded-[5px] bg-white/[0.08] border border-white/[0.1] text-[11px] font-mono text-text-2 leading-none">
      {children}
    </kbd>
  )
}

export function KeyboardShortcutsDialog() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ctrl+/ or Cmd+/
      if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault()
        setOpen((v) => !v)
        return
      }
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if ((e.target as HTMLElement)?.isContentEditable) return
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-[420px] p-0 bg-surface/95 backdrop-blur-xl border-white/[0.08] shadow-[0_24px_80px_rgba(0,0,0,0.6)] rounded-[16px] overflow-hidden gap-0"
      >
        <DialogTitle className="sr-only">Keyboard shortcuts</DialogTitle>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/[0.06]">
          <span className="text-[14px] font-600 text-text">Keyboard Shortcuts</span>
          <kbd className="px-1.5 py-0.5 rounded-[5px] bg-white/[0.06] border border-white/[0.08] text-[10px] font-mono text-text-3">
            ESC
          </kbd>
        </div>
        <div className="py-2 max-h-[400px] overflow-y-auto">
          {GROUPS.map((group) => (
            <div key={group.title} className="px-5 py-2">
              <h3 className="text-[11px] font-700 uppercase tracking-wider text-text-3/60 mb-2">
                {group.title}
              </h3>
              <div className="flex flex-col gap-1.5">
                {group.shortcuts.map((shortcut) => (
                  <div
                    key={shortcut.description}
                    className="flex items-center justify-between py-1"
                  >
                    <span className="text-[13px] text-text-2">{shortcut.description}</span>
                    <div className="flex items-center gap-1">
                      {shortcut.keys.map((key, i) => (
                        <Kbd key={i}>{key}</Kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
