'use client'

import { useTranslation } from 'react-i18next';
import { SidebarPanelShell } from '@/components/layout/sidebar-panel-shell'
import { MainContent } from '@/components/layout/main-content'
import { SecretsList } from '@/components/secrets/secrets-list'
import { useAppStore } from '@/stores/use-app-store'

export default function SecretsLayout({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  return (
    <>
      <SidebarPanelShell
        title={t('secrets')}
        createLabel={t('secret')}
        onNew={() => useAppStore.getState().setSecretSheetOpen(true)}
      >
        <SecretsList inSidebar />
      </SidebarPanelShell>
      <MainContent>{children}</MainContent>
    </>
  )
}
