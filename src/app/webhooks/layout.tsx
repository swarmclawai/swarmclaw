'use client'

import { SidebarPanelShell } from '@/components/layout/sidebar-panel-shell'
import { MainContent } from '@/components/layout/main-content'
import { WebhookList } from '@/components/webhooks/webhook-list'
import { useAppStore } from '@/stores/use-app-store'

export default function WebhooksLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SidebarPanelShell
        title="Webhooks"
        createLabel="Webhook"
        onNew={() => useAppStore.getState().setWebhookSheetOpen(true)}
      >
        <WebhookList inSidebar />
      </SidebarPanelShell>
      <MainContent>{children}</MainContent>
    </>
  )
}
