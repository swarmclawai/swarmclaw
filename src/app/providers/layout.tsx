'use client'

import { useTranslation } from 'react-i18next';
import { SidebarPanelShell } from '@/components/layout/sidebar-panel-shell'
import { MainContent } from '@/components/layout/main-content'
import { ProviderList } from '@/components/providers/provider-list'
import { useAppStore } from '@/stores/use-app-store'

export default function ProvidersLayout({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  return (
    <>
      <SidebarPanelShell
        title={t('providers')}
        createLabel={t('provider')}
        onNew={() => useAppStore.getState().setProviderSheetOpen(true)}
      >
        <ProviderList inSidebar />
      </SidebarPanelShell>
      <MainContent>{children}</MainContent>
    </>
  )
}
