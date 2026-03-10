'use client'

import { SidebarPanelShell } from '@/components/layout/sidebar-panel-shell'
import { MainContent } from '@/components/layout/main-content'
import { LogList } from '@/components/logs/log-list'

export default function LogsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SidebarPanelShell title="Logs">
        <LogList />
      </SidebarPanelShell>
      <MainContent>{children}</MainContent>
    </>
  )
}
