'use client'

import { useTranslation } from 'react-i18next';
import { SidebarPanelShell } from '@/components/layout/sidebar-panel-shell'
import { MainContent } from '@/components/layout/main-content'
import { SkillList } from '@/components/skills/skill-list'
import { useAppStore } from '@/stores/use-app-store'

export default function SkillsLayout({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  return (
    <>
      <SidebarPanelShell
        title={t('skills')}
        createLabel={t('skill')}
        onNew={() => useAppStore.getState().setSkillSheetOpen(true)}
      >
        <SkillList inSidebar />
      </SidebarPanelShell>
      <MainContent>{children}</MainContent>
    </>
  )
}
