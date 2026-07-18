'use client'

import { useTranslation } from 'react-i18next';
import { SidebarPanelShell } from '@/components/layout/sidebar-panel-shell'
import { MainContent } from '@/components/layout/main-content'
import { KnowledgeList } from '@/components/knowledge/knowledge-list'
import { useAppStore } from '@/stores/use-app-store'

export default function KnowledgeLayout({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  return (
    <>
      <SidebarPanelShell
        title={t('knowledge')}
        createLabel={t('newSource')}
        onNew={() => useAppStore.getState().setKnowledgeSheetOpen(true)}
      >
        <KnowledgeList />
      </SidebarPanelShell>
      <MainContent>{children}</MainContent>
    </>
  )
}
