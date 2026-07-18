'use client'

import { useTranslation } from 'react-i18next';
import { SidebarPanelShell } from '@/components/layout/sidebar-panel-shell'
import { MainContent } from '@/components/layout/main-content'
import { ConnectorList } from '@/components/connectors/connector-list'
import { useAppStore } from '@/stores/use-app-store'

export default function ConnectorsLayout({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  return (
    <>
      <SidebarPanelShell
        title={t('connectors')}
        createLabel={t('connector')}
        onNew={() => useAppStore.getState().setConnectorSheetOpen(true)}
      >
        <ConnectorList inSidebar />
      </SidebarPanelShell>
      <MainContent>{children}</MainContent>
    </>
  )
}
