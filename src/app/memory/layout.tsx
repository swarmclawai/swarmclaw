'use client'

import { SidebarPanelShell } from '@/components/layout/sidebar-panel-shell'
import { MainContent } from '@/components/layout/main-content'
import { MemoryAgentList } from '@/components/memory/memory-agent-list'
import { useAppStore } from '@/stores/use-app-store'

export default function MemoryLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SidebarPanelShell
        title="Memory"
        createLabel="Memory"
        onNew={() => useAppStore.getState().setMemorySheetOpen(true)}
      >
        <MemoryAgentList />
      </SidebarPanelShell>
      <MainContent>{children}</MainContent>
    </>
  )
}
