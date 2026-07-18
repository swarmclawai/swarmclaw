'use client'

import { useTranslation } from 'react-i18next';
import { SidebarPanelShell } from '@/components/layout/sidebar-panel-shell'
import { MainContent } from '@/components/layout/main-content'
import { ScheduleList } from '@/components/schedules/schedule-list'
import { useAppStore } from '@/stores/use-app-store'

export default function SchedulesLayout({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  return (
    <>
      <SidebarPanelShell
        title={t('schedules')}
        createLabel={t('schedule')}
        onNew={() => useAppStore.getState().setScheduleSheetOpen(true)}
      >
        <ScheduleList inSidebar />
      </SidebarPanelShell>
      <MainContent>{children}</MainContent>
    </>
  )
}
