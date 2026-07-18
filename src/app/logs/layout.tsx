'use client'

import { useTranslation } from 'react-i18next';
import { SidebarPanelShell } from '@/components/layout/sidebar-panel-shell'
import { MainContent } from '@/components/layout/main-content'
import { LogList } from '@/components/logs/log-list'

export default function LogsLayout({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  return (
    <>
      <SidebarPanelShell title={t('logs')}>
        <LogList />
      </SidebarPanelShell>
      <MainContent>{children}</MainContent>
    </>
  )
}
