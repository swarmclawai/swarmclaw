'use client'

import { SidebarPanelShell } from '@/components/layout/sidebar-panel-shell'
import { MainContent } from '@/components/layout/main-content'
import { McpServerList } from '@/components/mcp-servers/mcp-server-list'
import { useAppStore } from '@/stores/use-app-store'

export default function McpServersLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SidebarPanelShell
        title="MCP Servers"
        createLabel="MCP Server"
        onNew={() => useAppStore.getState().setMcpServerSheetOpen(true)}
      >
        <McpServerList />
      </SidebarPanelShell>
      <MainContent>{children}</MainContent>
    </>
  )
}
