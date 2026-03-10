'use client'

import { SidebarPanelShell } from '@/components/layout/sidebar-panel-shell'
import { MainContent } from '@/components/layout/main-content'
import { ConnectorList } from '@/components/connectors/connector-list'
import { useAppStore } from '@/stores/use-app-store'

export default function ConnectorsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SidebarPanelShell
        title="Connectors"
        createLabel="Connector"
        onNew={() => useAppStore.getState().setConnectorSheetOpen(true)}
      >
        <ConnectorList inSidebar />
      </SidebarPanelShell>
      <MainContent>{children}</MainContent>
    </>
  )
}
