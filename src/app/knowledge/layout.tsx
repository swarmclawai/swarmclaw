'use client'

import { SidebarPanelShell } from '@/components/layout/sidebar-panel-shell'
import { MainContent } from '@/components/layout/main-content'
import { KnowledgeList } from '@/components/knowledge/knowledge-list'
import { useAppStore } from '@/stores/use-app-store'

export default function KnowledgeLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SidebarPanelShell
        title="Knowledge"
        createLabel="Knowledge Entry"
        onNew={() => useAppStore.getState().setKnowledgeSheetOpen(true)}
      >
        <KnowledgeList />
      </SidebarPanelShell>
      <MainContent>{children}</MainContent>
    </>
  )
}
