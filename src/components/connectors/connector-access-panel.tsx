'use client'

import type {
  Connector,
  ConnectorAccessMutationAction,
  ConnectorAccessSnapshot,
  ConnectorDmAddressingMode,
} from '@/types'

type ConnectorAccessPanelProps = {
  connector: Connector | null
  snapshot: ConnectorAccessSnapshot | null
  loading?: boolean
  error?: string | null
  pending?: boolean
  senderId?: string | null
  senderIdAlt?: string | null
  senderName?: string | null
  title?: string
  description?: string
  onAction?: (action: ConnectorAccessMutationAction, payload?: {
    senderId?: string | null
    senderIdAlt?: string | null
    code?: string | null
    dmAddressingMode?: ConnectorDmAddressingMode | null
  }) => void | Promise<void>
}

function ListPills({ items, emptyLabel }: { items: string[]; emptyLabel: string }) {
  if (items.length === 0) {
    return <div className="text-[12px] text-text-3">{emptyLabel}</div>
  }
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => (
        <span
          key={item}
          className="inline-flex items-center rounded-full border border-white/[0.08] bg-white/[0.04] px-2.5 py-1 text-[11px] text-text-2"
        >
          {item}
        </span>
      ))}
    </div>
  )
}

function ActionButton(props: {
  label: string
  onClick?: () => void
  tone?: 'default' | 'danger' | 'success'
  disabled?: boolean
}) {
  const toneClass = props.tone === 'danger'
    ? 'border-red-500/25 text-red-300 hover:bg-red-500/10'
    : props.tone === 'success'
      ? 'border-emerald-500/25 text-emerald-300 hover:bg-emerald-500/10'
      : 'border-white/[0.08] text-text-2 hover:bg-white/[0.05]'

  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      className={`rounded-[10px] border px-3 py-2 text-[12px] font-600 transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${toneClass}`}
    >
      {props.label}
    </button>
  )
}

export function ConnectorAccessPanel(props: ConnectorAccessPanelProps) {
  const {
    connector,
    snapshot,
    loading = false,
    error,
    pending = false,
    senderId,
    senderIdAlt,
    senderName,
    title = 'Access & Ownership',
    description,
    onAction,
  } = props

  const senderStatus = snapshot?.senderStatus || null
  const effectiveSenderLabel = senderName || senderId || senderIdAlt || ''
  const hasSelectedSender = !!effectiveSenderLabel
  const canAct = !!onAction && !loading && !pending
  const connectorManagedAllow = !!senderStatus && (senderStatus.isConfigAllowed || senderStatus.isStoredAllowed)
  const senderUsesDirectAddress = senderStatus?.requiresDirectAddress === true
  const senderHasAddressingOverride = senderStatus?.dmAddressingOverride !== null && senderStatus?.dmAddressingOverride !== undefined

  return (
    <div className="rounded-[18px] border border-white/[0.08] bg-white/[0.03] overflow-hidden">
      <div className="border-b border-white/[0.06] px-4 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[13px] font-700 text-text">{title}</div>
            <div className="mt-1 text-[12px] text-text-3">
              {description || `Manage direct-message access, pairing, and owner routing for ${connector?.name || 'this connector'}.`}
            </div>
          </div>
          {snapshot && (
            <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.08em] text-text-3">
              <span className="rounded-full bg-white/[0.04] px-2.5 py-1">DM {snapshot.dmPolicy}</span>
              <span className="rounded-full bg-white/[0.04] px-2.5 py-1">
                {snapshot.dmAddressingMode === 'addressed' ? 'Name required' : 'Any DM'}
              </span>
              <span className="rounded-full bg-white/[0.04] px-2.5 py-1">{snapshot.pendingPairingRequests.length} pending</span>
              <span className="rounded-full bg-white/[0.04] px-2.5 py-1">{snapshot.storedAllowedSenderIds.length} paired</span>
              <span className="rounded-full bg-white/[0.04] px-2.5 py-1">{snapshot.denyFrom.length} blocked</span>
            </div>
          )}
        </div>
      </div>

      <div className="space-y-4 px-4 py-4">
        {error && (
          <div className="rounded-[12px] border border-red-500/20 bg-red-500/8 px-3 py-2 text-[12px] text-red-200">
            {error}
          </div>
        )}
        {loading ? (
          <div className="text-[12px] text-text-3">Loading connector access…</div>
        ) : !snapshot ? (
          <div className="text-[12px] text-text-3">No connector access snapshot is available yet.</div>
        ) : (
          <>
            {hasSelectedSender && (
              <div className="rounded-[14px] border border-white/[0.06] bg-black/20 px-4 py-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-[12px] uppercase tracking-[0.08em] text-text-3">Selected Sender</div>
                    <div className="mt-1 text-[16px] font-700 text-text">{effectiveSenderLabel}</div>
                    {senderId && senderId !== effectiveSenderLabel && (
                      <div className="mt-1 text-[11px] text-text-3">{senderId}</div>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {senderStatus?.isOwnerOverride && <span className="rounded-full bg-sky-500/12 px-2.5 py-1 text-[10px] uppercase tracking-[0.08em] text-sky-200">Owner</span>}
                    {senderStatus?.isBlocked && <span className="rounded-full bg-red-500/12 px-2.5 py-1 text-[10px] uppercase tracking-[0.08em] text-red-200">Blocked</span>}
                    {senderStatus?.isApproved && !senderStatus.isBlocked && <span className="rounded-full bg-emerald-500/12 px-2.5 py-1 text-[10px] uppercase tracking-[0.08em] text-emerald-200">Approved</span>}
                    {senderStatus?.isPending && !senderStatus.isApproved && !senderStatus.isBlocked && <span className="rounded-full bg-amber-500/12 px-2.5 py-1 text-[10px] uppercase tracking-[0.08em] text-amber-200">Pending</span>}
                    {senderUsesDirectAddress && <span className="rounded-full bg-orange-500/12 px-2.5 py-1 text-[10px] uppercase tracking-[0.08em] text-orange-200">Name required</span>}
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {!senderStatus?.isBlocked ? (
                    <ActionButton
                      label={connectorManagedAllow ? 'Remove connector allow' : 'Allow sender'}
                      disabled={!canAct || !senderId}
                      tone={connectorManagedAllow ? 'default' : 'success'}
                      onClick={() => onAction?.(connectorManagedAllow ? 'remove_allowed_sender' : 'allow_sender', { senderId, senderIdAlt })}
                    />
                  ) : (
                    <ActionButton
                      label="Unblock sender"
                      disabled={!canAct || !senderId}
                      onClick={() => onAction?.('unblock_sender', { senderId, senderIdAlt })}
                    />
                  )}
                  {!senderStatus?.isBlocked && (
                    <ActionButton
                      label="Block sender"
                      disabled={!canAct || !senderId}
                      tone="danger"
                      onClick={() => onAction?.('block_sender', { senderId, senderIdAlt })}
                    />
                  )}
                  <ActionButton
                    label={senderStatus?.isOwnerOverride ? 'Clear owner' : 'Set as owner'}
                    disabled={!canAct || (!senderStatus?.isOwnerOverride && !senderId)}
                    onClick={() => onAction?.(
                      senderStatus?.isOwnerOverride ? 'clear_owner' : 'set_owner',
                      { senderId, senderIdAlt },
                    )}
                  />
                  {senderStatus?.isPending && (
                    <>
                      <ActionButton
                        label="Approve pairing"
                        disabled={!canAct || !senderId}
                        tone="success"
                        onClick={() => onAction?.('approve_pairing', { senderId, senderIdAlt, code: senderStatus.pendingCode || null })}
                      />
                      <ActionButton
                        label="Reject pairing"
                        disabled={!canAct || !senderId}
                        tone="danger"
                        onClick={() => onAction?.('reject_pairing', { senderId, senderIdAlt, code: senderStatus.pendingCode || null })}
                      />
                    </>
                  )}
                  <ActionButton
                    label="Always reply"
                    disabled={!canAct || !senderId || (!senderHasAddressingOverride && senderStatus?.effectiveDmAddressingMode === 'open')}
                    onClick={() => onAction?.('set_sender_dm_addressing', { senderId, senderIdAlt, dmAddressingMode: 'open' })}
                  />
                  <ActionButton
                    label="Require agent name"
                    disabled={!canAct || !senderId || senderStatus?.effectiveDmAddressingMode === 'addressed'}
                    onClick={() => onAction?.('set_sender_dm_addressing', { senderId, senderIdAlt, dmAddressingMode: 'addressed' })}
                  />
                  {senderHasAddressingOverride && (
                    <ActionButton
                      label="Use connector default"
                      disabled={!canAct || !senderId}
                      onClick={() => onAction?.('clear_sender_dm_addressing', { senderId, senderIdAlt })}
                    />
                  )}
                </div>
                <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-text-3">
                  {senderStatus?.isConfigAllowed && <span>Connector allowlist</span>}
                  {senderStatus?.isStoredAllowed && <span>Paired sender store</span>}
                  {senderStatus?.isGlobalAllowed && <span>Global WhatsApp approvals</span>}
                  {senderStatus?.isBlocked && <span>Deny list blocks pairing and replies</span>}
                  {senderStatus?.requiresDirectAddress && <span>Needs the agent name or a reply to one of its messages</span>}
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              <div className="rounded-[14px] border border-white/[0.06] bg-black/20 px-3 py-3">
                <div className="text-[10px] uppercase tracking-[0.08em] text-text-3">Configured Allow</div>
                <div className="mt-2 text-[22px] font-display font-700 tracking-[-0.04em] text-text">{snapshot.allowFrom.length}</div>
              </div>
              <div className="rounded-[14px] border border-white/[0.06] bg-black/20 px-3 py-3">
                <div className="text-[10px] uppercase tracking-[0.08em] text-text-3">Stored Pairings</div>
                <div className="mt-2 text-[22px] font-display font-700 tracking-[-0.04em] text-text">{snapshot.storedAllowedSenderIds.length}</div>
              </div>
              <div className="rounded-[14px] border border-white/[0.06] bg-black/20 px-3 py-3">
                <div className="text-[10px] uppercase tracking-[0.08em] text-text-3">Pending</div>
                <div className="mt-2 text-[22px] font-display font-700 tracking-[-0.04em] text-text">{snapshot.pendingPairingRequests.length}</div>
              </div>
              <div className="rounded-[14px] border border-white/[0.06] bg-black/20 px-3 py-3">
                <div className="text-[10px] uppercase tracking-[0.08em] text-text-3">Blocked</div>
                <div className="mt-2 text-[22px] font-display font-700 tracking-[-0.04em] text-text">{snapshot.denyFrom.length}</div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <div className="rounded-[14px] border border-white/[0.06] bg-black/20 px-4 py-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-[12px] font-700 text-text">DM Addressing Default</div>
                  <div className="flex flex-wrap gap-2">
                    <ActionButton
                      label="Reply to any DM"
                      disabled={!canAct || snapshot.dmAddressingMode === 'open'}
                      onClick={() => onAction?.('set_dm_addressing_mode', { dmAddressingMode: 'open' })}
                    />
                    <ActionButton
                      label="Require agent name"
                      disabled={!canAct || snapshot.dmAddressingMode === 'addressed'}
                      onClick={() => onAction?.('set_dm_addressing_mode', { dmAddressingMode: 'addressed' })}
                    />
                  </div>
                </div>
                <div className="mt-3 text-[12px] text-text-2">
                  {snapshot.dmAddressingMode === 'addressed'
                    ? 'Direct messages only trigger when the sender addresses the agent by name or replies to one of its messages.'
                    : 'Direct messages can trigger normally without naming the agent.'}
                </div>
              </div>

              <div className="rounded-[14px] border border-white/[0.06] bg-black/20 px-4 py-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-[12px] font-700 text-text">Owner Override</div>
                  {snapshot.ownerSenderId && (
                    <ActionButton
                      label="Clear"
                      disabled={!canAct}
                      onClick={() => onAction?.('clear_owner')}
                    />
                  )}
                </div>
                <div className="mt-3 text-[12px] text-text-2">
                  {snapshot.ownerSenderId || 'No explicit owner override set'}
                </div>
              </div>

              <div className="rounded-[14px] border border-white/[0.06] bg-black/20 px-4 py-4">
                <div className="text-[12px] font-700 text-text">Configured Allowlist</div>
                <div className="mt-3">
                  <ListPills items={snapshot.allowFrom} emptyLabel="No connector-specific allowlist entries." />
                </div>
              </div>

              <div className="rounded-[14px] border border-white/[0.06] bg-black/20 px-4 py-4">
                <div className="text-[12px] font-700 text-text">Paired Senders</div>
                <div className="mt-3 space-y-2">
                  {snapshot.storedAllowedSenderIds.length === 0 ? (
                    <div className="text-[12px] text-text-3">No stored paired senders yet.</div>
                  ) : snapshot.storedAllowedSenderIds.map((entry) => (
                    <div key={entry} className="flex flex-wrap items-center justify-between gap-2 rounded-[12px] border border-white/[0.06] bg-white/[0.03] px-3 py-2">
                      <div className="text-[12px] text-text-2 break-all">{entry}</div>
                      <div className="flex flex-wrap gap-2">
                        <ActionButton
                          label="Remove"
                          disabled={!canAct}
                          onClick={() => onAction?.('remove_allowed_sender', { senderId: entry })}
                        />
                        <ActionButton
                          label="Block"
                          disabled={!canAct}
                          tone="danger"
                          onClick={() => onAction?.('block_sender', { senderId: entry })}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-[14px] border border-white/[0.06] bg-black/20 px-4 py-4">
                <div className="text-[12px] font-700 text-text">Blocked Senders</div>
                <div className="mt-3">
                  <ListPills items={snapshot.denyFrom} emptyLabel="No blocked senders on this connector." />
                </div>
              </div>

              <div className="rounded-[14px] border border-white/[0.06] bg-black/20 px-4 py-4">
                <div className="text-[12px] font-700 text-text">DM Addressing Overrides</div>
                <div className="mt-3 space-y-2">
                  {snapshot.senderAddressingOverrides.length === 0 ? (
                    <div className="text-[12px] text-text-3">No sender-specific DM addressing overrides.</div>
                  ) : snapshot.senderAddressingOverrides.map((entry) => (
                    <div key={entry.senderId} className="flex flex-wrap items-center justify-between gap-2 rounded-[12px] border border-white/[0.06] bg-white/[0.03] px-3 py-2">
                      <div className="min-w-0">
                        <div className="text-[12px] text-text-2 break-all">{entry.senderId}</div>
                        <div className="mt-1 text-[11px] text-text-3">
                          {entry.dmAddressingMode === 'addressed' ? 'Requires agent name or reply' : 'Always reply'}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <ActionButton
                          label="Reply to any DM"
                          disabled={!canAct || entry.dmAddressingMode === 'open'}
                          onClick={() => onAction?.('set_sender_dm_addressing', { senderId: entry.senderId, dmAddressingMode: 'open' })}
                        />
                        <ActionButton
                          label="Require name"
                          disabled={!canAct || entry.dmAddressingMode === 'addressed'}
                          onClick={() => onAction?.('set_sender_dm_addressing', { senderId: entry.senderId, dmAddressingMode: 'addressed' })}
                        />
                        <ActionButton
                          label="Default"
                          disabled={!canAct}
                          onClick={() => onAction?.('clear_sender_dm_addressing', { senderId: entry.senderId })}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-[14px] border border-white/[0.06] bg-black/20 px-4 py-4 xl:col-span-2">
                <div className="text-[12px] font-700 text-text">Pending Pairing Requests</div>
                <div className="mt-3 space-y-2">
                  {snapshot.pendingPairingRequests.length === 0 ? (
                    <div className="text-[12px] text-text-3">No pending pairing requests.</div>
                  ) : snapshot.pendingPairingRequests.map((entry) => (
                    <div key={entry.code} className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-white/[0.06] bg-white/[0.03] px-3 py-3">
                      <div className="min-w-0">
                        <div className="text-[12px] font-600 text-text">
                          {entry.senderName ? `${entry.senderName} (${entry.senderId})` : entry.senderId}
                        </div>
                        <div className="mt-1 text-[11px] text-text-3">
                          Code {entry.code}{entry.channelId ? ` · ${entry.channelId}` : ''}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <ActionButton
                          label="Approve"
                          disabled={!canAct}
                          tone="success"
                          onClick={() => onAction?.('approve_pairing', { senderId: entry.senderId, code: entry.code })}
                        />
                        <ActionButton
                          label="Reject"
                          disabled={!canAct}
                          onClick={() => onAction?.('reject_pairing', { senderId: entry.senderId, code: entry.code })}
                        />
                        <ActionButton
                          label="Block"
                          disabled={!canAct}
                          tone="danger"
                          onClick={() => onAction?.('block_sender', { senderId: entry.senderId })}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {snapshot.platform === 'whatsapp' && (
                <div className="rounded-[14px] border border-white/[0.06] bg-black/20 px-4 py-4 xl:col-span-2">
                  <div className="text-[12px] font-700 text-text">Global WhatsApp Approved Contacts</div>
                  <div className="mt-1 text-[11px] text-text-3">
                    Read-only here. Edit these in Settings.
                  </div>
                  <div className="mt-3">
                    <ListPills
                      items={snapshot.globalWhatsAppApprovedContacts.map((entry) => `${entry.label} · ${entry.phone}`)}
                      emptyLabel="No global WhatsApp approved contacts."
                    />
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
