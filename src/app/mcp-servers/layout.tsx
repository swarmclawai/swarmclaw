'use client'

import { useTranslation } from 'react-i18next';
import { SidebarPanelShell } from '@/components/layout/sidebar-panel-shell'
import { MainContent } from '@/components/layout/main-content'
import { McpServerList } from '@/components/mcp-servers/mcp-server-list'
import { useAppStore } from '@/stores/use-app-store'

export default function McpServersLayout({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  return (
    <>
      <SidebarPanelShell
        title={t('mcpServers')}
        createLabel={t('mcpServer')}
        onNew={() => useAppStore.getState().setMcpServerSheetOpen(true)}
      >
        <McpServerList />
      </SidebarPanelShell>
      <MainContent>{children}</MainContent>
    </>
  )
}
