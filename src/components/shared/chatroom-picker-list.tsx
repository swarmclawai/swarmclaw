'use client'

import { CheckIcon } from '@/components/shared/check-icon'
import type { Chatroom } from '@/types'

interface Props {
  chatrooms: Chatroom[]
  selected: string
  onSelect: (chatroomId: string) => void
  maxHeight?: number
}

export function ChatroomPickerList({
  chatrooms,
  selected,
  onSelect,
  maxHeight = 220,
}: Props) {
  if (chatrooms.length === 0) {
    return <p className="text-[13px] text-text-3">No chat rooms created yet.</p>
  }

  return (
    <div
      className="flex flex-col gap-1 rounded-[14px] border border-white/[0.06] bg-surface p-1.5 overflow-y-auto"
      style={{ maxHeight }}
    >
      {chatrooms.map((cr) => {
        const active = selected === cr.id
        return (
          <button
            key={cr.id}
            onClick={() => onSelect(cr.id)}
            className={`relative flex items-center gap-3 px-3 py-2.5 rounded-[10px] cursor-pointer transition-all w-full text-left border-none
              ${active ? 'bg-accent-soft' : 'bg-transparent hover:bg-white/[0.03]'}`}
            style={{ fontFamily: 'inherit' }}
          >
            {active && (
              <div className="absolute left-0 top-2 bottom-2 w-[2.5px] rounded-full bg-accent-bright" />
            )}
            <div className="w-[28px] h-[28px] rounded-full bg-white/[0.06] flex items-center justify-center shrink-0">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={active ? 'text-accent-bright' : 'text-text-3'}>
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <span className={`text-[13px] font-600 block truncate ${active ? 'text-accent-bright' : 'text-text-2'}`}>
                {cr.name}
              </span>
              <span className="text-[11px] text-text-3/60 block truncate">
                {cr.agentIds.length} agent{cr.agentIds.length !== 1 ? 's' : ''}
                {cr.chatMode === 'parallel' ? ' · parallel' : ' · sequential'}
              </span>
            </div>
            {active && <CheckIcon className="text-accent-bright shrink-0" />}
          </button>
        )
      })}
    </div>
  )
}
