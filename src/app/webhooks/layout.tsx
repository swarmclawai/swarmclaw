'use client'

import { useTranslation } from 'react-i18next';
import { SidebarPanelShell } from '@/components/layout/sidebar-panel-shell'
import { MainContent } from '@/components/layout/main-content'
import { WebhookList } from '@/components/webhooks/webhook-list'
import { useAppStore } from '@/stores/use-app-store'

export default function WebhooksLayout({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  return (
    <>
      <SidebarPanelShell
        title={t('webhooks')}
        createLabel={t('webhook')}
        onNew={() => useAppStore.getState().setWebhookSheetOpen(true)}
      >
        <WebhookList inSidebar />
      </SidebarPanelShell>
      <MainContent>{children}</MainContent>
    </>
  )
}
