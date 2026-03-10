'use client'

import { SidebarPanelShell } from '@/components/layout/sidebar-panel-shell'
import { MainContent } from '@/components/layout/main-content'
import { SkillList } from '@/components/skills/skill-list'
import { useAppStore } from '@/stores/use-app-store'

export default function SkillsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SidebarPanelShell
        title="Skills"
        createLabel="Skill"
        onNew={() => useAppStore.getState().setSkillSheetOpen(true)}
      >
        <SkillList inSidebar />
      </SidebarPanelShell>
      <MainContent>{children}</MainContent>
    </>
  )
}
