'use client'

import { useTranslation } from 'react-i18next';
import { SidebarPanelShell } from '@/components/layout/sidebar-panel-shell'
import { MainContent } from '@/components/layout/main-content'
import { ExtensionList } from '@/components/extensions/extension-list'
import { useAppStore } from '@/stores/use-app-store'

export default function ExtensionsLayout({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  return (
    <>
      <SidebarPanelShell
        title={t('extensions')}
        createLabel={t('extension')}
        onNew={() => useAppStore.getState().setExtensionSheetOpen(true)}
      >
        <ExtensionList inSidebar />
      </SidebarPanelShell>
      <MainContent>{children}</MainContent>
    </>
  )
}
