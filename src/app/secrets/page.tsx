'use client'

import { useAppStore } from '@/stores/use-app-store'
import { SecretsList } from '@/components/secrets/secrets-list'

export default function SecretsPage() {
  return (
    <div className="flex-1 flex flex-col h-full">
      <div className="flex items-center px-6 pt-5 pb-3 shrink-0">
        <h2 className="font-display text-[14px] font-600 text-text-2 tracking-[-0.01em] capitalize flex-1">
          Secrets
        </h2>
        <button
          onClick={() => useAppStore.getState().setSecretSheetOpen(true)}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] text-[11px] font-600 text-accent-bright bg-accent-soft hover:bg-accent-bright/15 transition-all cursor-pointer"
          style={{ fontFamily: 'inherit' }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Secret
        </button>
      </div>
      <SecretsList />
    </div>
  )
}
