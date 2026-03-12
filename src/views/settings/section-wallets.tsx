'use client'

import type { SettingsSectionProps } from './types'

export function WalletsSection({ appSettings, patchSettings }: SettingsSectionProps) {
  const walletApprovalsEnabled = appSettings.walletApprovalsEnabled !== false

  return (
    <div className="mb-10">
      <h3 className="font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
        Wallets
      </h3>
      <p className="text-[12px] text-text-3 mb-5">
        Global override for wallet approval prompts. Turn this off to auto-execute wallet sends and other wallet actions without creating pending approval steps.
      </p>

      <div className="flex items-center justify-between rounded-[14px] border border-white/[0.06] bg-white/[0.03] px-4 py-3">
        <div className="pr-4">
          <label className="text-[12px] font-600 text-text-2 block">Wallet Approvals</label>
          <p className="text-[11px] text-text-3/60 mt-0.5">
            When disabled, wallet actions bypass approval gates globally. Per-wallet approval toggles remain stored, but they are ignored until this is turned back on.
          </p>
        </div>
        <button
          type="button"
          onClick={() => patchSettings({ walletApprovalsEnabled: !walletApprovalsEnabled })}
          className={`relative w-9 h-5 rounded-full transition-colors ${walletApprovalsEnabled ? 'bg-accent-bright' : 'bg-white/[0.10]'}`}
          style={{ fontFamily: 'inherit' }}
        >
          <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${walletApprovalsEnabled ? 'translate-x-4' : ''}`} />
        </button>
      </div>
    </div>
  )
}
