'use client'

import { SidebarPanelShell } from '@/components/layout/sidebar-panel-shell'
import { MainContent } from '@/components/layout/main-content'
import { ProviderList } from '@/components/providers/provider-list'
import { useAppStore } from '@/stores/use-app-store'

export default function ProvidersLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SidebarPanelShell
        title="Providers"
        createLabel="Provider"
        onNew={() => useAppStore.getState().setProviderSheetOpen(true)}
      >
        <ProviderList inSidebar />
      </SidebarPanelShell>
      <MainContent>{children}</MainContent>
    </>
  )
}
