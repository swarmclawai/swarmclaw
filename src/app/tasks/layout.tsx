'use client'

import { SidebarPanelShell } from '@/components/layout/sidebar-panel-shell'
import { MainContent } from '@/components/layout/main-content'
import { TaskList } from '@/components/tasks/task-list'
import { useAppStore } from '@/stores/use-app-store'

export default function TasksLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SidebarPanelShell
        title="Tasks"
        createLabel="Task"
        onNew={() => useAppStore.getState().setTaskSheetOpen(true)}
      >
        <TaskList inSidebar />
      </SidebarPanelShell>
      <MainContent>{children}</MainContent>
    </>
  )
}
