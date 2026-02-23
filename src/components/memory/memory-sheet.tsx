'use client'

import { useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { createMemory } from '@/lib/memory'
import { BottomSheet } from '@/components/shared/bottom-sheet'

export function MemorySheet() {
  const open = useAppStore((s) => s.memorySheetOpen)
  const setOpen = useAppStore((s) => s.setMemorySheetOpen)
  const triggerRefresh = useAppStore((s) => s.triggerMemoryRefresh)

  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')

  const onClose = () => {
    setOpen(false)
    setTitle('')
    setContent('')
  }

  const handleSave = async () => {
    await createMemory({
      title: title.trim() || 'Untitled',
      category: 'general',
      content,
      agentId: null,
      sessionId: null,
    })
    triggerRefresh()
    onClose()
  }

  const inputClass = "w-full px-4 py-3.5 rounded-[14px] border border-white/[0.08] bg-surface text-text text-[15px] outline-none transition-all duration-200 placeholder:text-text-3/50 focus-glow"

  return (
    <BottomSheet open={open} onClose={onClose}>
      <div className="mb-10">
        <h2 className="font-display text-[28px] font-700 tracking-[-0.03em] mb-2">New Memory</h2>
        <p className="text-[14px] text-text-3">Store a piece of knowledge</p>
      </div>

      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Title</label>
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Memory title" className={inputClass} style={{ fontFamily: 'inherit' }} />
      </div>

      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Content</label>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Memory content..."
          rows={6}
          className={`${inputClass} resize-y min-h-[150px]`}
          style={{ fontFamily: 'inherit' }}
        />
      </div>

      <div className="flex gap-3 pt-2 border-t border-white/[0.04]">
        <button onClick={onClose} className="flex-1 py-3.5 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[15px] font-600 cursor-pointer hover:bg-surface-2 transition-all" style={{ fontFamily: 'inherit' }}>
          Cancel
        </button>
        <button onClick={handleSave} disabled={!title.trim()} className="flex-1 py-3.5 rounded-[14px] border-none bg-primary text-primary-foreground text-[15px] font-600 cursor-pointer active:scale-[0.97] disabled:opacity-30 transition-all shadow-[0_4px_20px_rgba(var(--primary-rgb),0.25)] hover:brightness-110" style={{ fontFamily: 'inherit' }}>
          Save
        </button>
      </div>
    </BottomSheet>
  )
}
