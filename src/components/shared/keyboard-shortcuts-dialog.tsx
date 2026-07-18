'use client'

import { useTranslation } from 'react-i18next';
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

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded-[5px] bg-white/[0.08] border border-white/[0.1] text-[11px] font-mono text-text-2 leading-none">
      {children}
    </kbd>
  )
}

export function KeyboardShortcutsDialog() {
  const { t } = useTranslation()
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

  // 构建快捷键组数据，使用翻译
  const shortcutGroups: ShortcutGroup[] = [
    {
      title: t('keyboardNavTitle'),
      shortcuts: [
        { keys: [MOD, 'K'], description: t('keyboardOpenSearch') },
        { keys: [MOD, 'Shift', 'A'], description: t('keyboardSwitchAgent') },
        { keys: [MOD, 'N'], description: t('keyboardNewChat') },
        { keys: [MOD, 'Shift', 'T'], description: t('keyboardJumpTasks') },
      ],
    },
    {
      title: t('keyboardChatTitle'),
      shortcuts: [
        { keys: ['Enter'], description: t('keyboardSendMessage') },
        { keys: ['Shift', 'Enter'], description: t('keyboardNewLine') },
        { keys: ['Esc'], description: t('keyboardCancelReply') },
      ],
    },
    {
      title: t('keyboardGeneralTitle'),
      shortcuts: [
        { keys: ['?'], description: t('keyboardShowShortcuts') },
      ],
    },
  ]

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-[420px] p-0 bg-surface/95 backdrop-blur-xl border-white/[0.08] shadow-[0_24px_80px_rgba(0,0,0,0.6)] rounded-[16px] overflow-hidden gap-0"
      >
        <DialogTitle className="sr-only">{t('keyboardShortcuts')}</DialogTitle>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/[0.06]">
          <span className="text-[14px] font-600 text-text">{t('keyboardShortcuts')}</span>
          <kbd className="px-1.5 py-0.5 rounded-[5px] bg-white/[0.06] border border-white/[0.08] text-[10px] font-mono text-text-3">
            ESC
          </kbd>
        </div>
        <div className="py-2 max-h-[400px] overflow-y-auto">
          {shortcutGroups.map((group) => (
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
