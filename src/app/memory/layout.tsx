'use client'

import { useTranslation } from 'react-i18next';
import { SidebarPanelShell } from '@/components/layout/sidebar-panel-shell'
import { MainContent } from '@/components/layout/main-content'
import { MemoryAgentList } from '@/components/memory/memory-agent-list'
import { useAppStore } from '@/stores/use-app-store'

export default function MemoryLayout({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  return (
    <>
      <SidebarPanelShell
        title={t('memory')}
        createLabel={t('memory')}
        onNew={() => useAppStore.getState().setMemorySheetOpen(true)}
      >
        <MemoryAgentList />
      </SidebarPanelShell>
      <MainContent>{children}</MainContent>
    </>
  )
}
