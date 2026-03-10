'use client'

import { useChatroomStore } from '@/stores/use-chatroom-store'
import { ChatroomList } from '@/components/chatrooms/chatroom-list'
import { ChatroomView } from '@/components/chatrooms/chatroom-view'
import { MainContent } from '@/components/layout/main-content'

export default function ChatroomsPage() {
  return (
    <MainContent>
      <div className="flex-1 flex h-full min-w-0">
        <div className="w-[280px] shrink-0 border-r border-white/[0.06] flex flex-col">
          <div className="flex items-center px-4 pt-4 pb-2 shrink-0">
            <h2 className="font-display text-[14px] font-600 text-text-2 tracking-[-0.01em] flex-1">Chatrooms</h2>
            <button
              onClick={() => {
                useChatroomStore.getState().setEditingChatroomId(null)
                useChatroomStore.getState().setChatroomSheetOpen(true)
              }}
              className="flex items-center gap-1 px-2 py-1 rounded-[6px] text-[11px] font-600 text-accent-bright bg-accent-soft hover:bg-accent-bright/15 transition-all cursor-pointer"
              style={{ fontFamily: 'inherit' }}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              New
            </button>
          </div>
          <ChatroomList />
        </div>
        <ChatroomView />
      </div>
    </MainContent>
  )
}
