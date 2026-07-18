'use client'

import { useTranslation } from 'react-i18next';
import { SidebarPanelShell } from '@/components/layout/sidebar-panel-shell'
import { MainContent } from '@/components/layout/main-content'
import { RunList } from '@/components/runs/run-list'

export default function RunsLayout({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  return (
    <>
      <SidebarPanelShell title={t('runs')}>
        <RunList />
      </SidebarPanelShell>
      <MainContent>{children}</MainContent>
    </>
  )
}
