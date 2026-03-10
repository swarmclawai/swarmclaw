'use client'

import { SidebarPanelShell } from '@/components/layout/sidebar-panel-shell'
import { MainContent } from '@/components/layout/main-content'
import { ScheduleList } from '@/components/schedules/schedule-list'
import { useAppStore } from '@/stores/use-app-store'

export default function SchedulesLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SidebarPanelShell
        title="Schedules"
        createLabel="Schedule"
        onNew={() => useAppStore.getState().setScheduleSheetOpen(true)}
      >
        <ScheduleList inSidebar />
      </SidebarPanelShell>
      <MainContent>{children}</MainContent>
    </>
  )
}
