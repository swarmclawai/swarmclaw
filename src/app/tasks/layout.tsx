'use client'

import { useTranslation } from 'react-i18next';
import { SidebarPanelShell } from '@/components/layout/sidebar-panel-shell'
import { MainContent } from '@/components/layout/main-content'
import { TaskList } from '@/components/tasks/task-list'
import { useAppStore } from '@/stores/use-app-store'

export default function TasksLayout({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  return (
    <>
      <SidebarPanelShell
        title={t('tasks')}
        createLabel={t('task')}
        onNew={() => useAppStore.getState().setTaskSheetOpen(true)}
      >
        <TaskList inSidebar />
      </SidebarPanelShell>
      <MainContent>{children}</MainContent>
    </>
  )
}
