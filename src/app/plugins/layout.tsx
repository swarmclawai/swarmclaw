'use client'

import { SidebarPanelShell } from '@/components/layout/sidebar-panel-shell'
import { MainContent } from '@/components/layout/main-content'
import { PluginList } from '@/components/plugins/plugin-list'
import { useAppStore } from '@/stores/use-app-store'

export default function PluginsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SidebarPanelShell
        title="Plugins"
        createLabel="Plugin"
        onNew={() => useAppStore.getState().setPluginSheetOpen(true)}
      >
        <PluginList inSidebar />
      </SidebarPanelShell>
      <MainContent>{children}</MainContent>
    </>
  )
}
