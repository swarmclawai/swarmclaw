'use client'

import { useState } from 'react'
import { SidebarPanelShell } from '@/components/layout/sidebar-panel-shell'
import { MainContent } from '@/components/layout/main-content'
import { AgentChatList } from '@/components/agents/agent-chat-list'
import { AgentList } from '@/components/agents/agent-list'
import { useAppStore } from '@/stores/use-app-store'

export default function AgentsLayout({ children }: { children: React.ReactNode }) {
  const [agentViewMode, setAgentViewMode] = useState<'chat' | 'config'>('chat')

  return (
    <>
      <SidebarPanelShell
        title="Agents"
        createLabel="Agent"
        onNew={() => useAppStore.getState().setAgentSheetOpen(true)}
        headerContent={
          <div className="flex gap-1 px-4 pb-2">
            {(['chat', 'config'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setAgentViewMode(mode)}
                className={`px-3 py-1.5 rounded-[8px] text-[11px] font-600 capitalize cursor-pointer transition-all
                  ${agentViewMode === mode ? 'bg-accent-soft text-accent-bright' : 'bg-transparent text-text-3 hover:text-text-2'}`}
                style={{ fontFamily: 'inherit' }}
              >
                {mode}
              </button>
            ))}
          </div>
        }
      >
        {agentViewMode === 'chat' ? <AgentChatList inSidebar /> : <AgentList inSidebar />}
      </SidebarPanelShell>
      <MainContent>{children}</MainContent>
    </>
  )
}
