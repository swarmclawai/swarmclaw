'use client'

import { SidebarPanelShell } from '@/components/layout/sidebar-panel-shell'
import { MainContent } from '@/components/layout/main-content'
import { RunList } from '@/components/runs/run-list'

export default function RunsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SidebarPanelShell title="Runs">
        <RunList />
      </SidebarPanelShell>
      <MainContent>{children}</MainContent>
    </>
  )
}
