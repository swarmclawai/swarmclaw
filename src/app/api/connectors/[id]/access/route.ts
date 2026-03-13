import { NextResponse } from 'next/server'
import type { Connector, ConnectorAccessMutationAction, ConnectorAccessMutationResponse } from '@/types'
import { notFound } from '@/lib/server/collection-helpers'
import {
  loadConnectors,
  logActivity,
  upsertStoredItem,
} from '@/lib/server/storage'
import { ensureDaemonStarted } from '@/lib/server/runtime/daemon-state'
import { notify } from '@/lib/server/ws-hub'
import { errorMessage } from '@/lib/shared-utils'
import {
  buildConnectorAccessSnapshot,
  resolveConnectorOwnerSenderId,
} from '@/lib/server/connectors/access'
import {
  addAllowedSender,
  approvePairingCode,
  approvePendingSender,
  clearSenderAddressingOverride,
  normalizeSenderId,
  parseAllowFromCsv,
  parseDmAddressingMode,
  parsePairingPolicy,
  removeAllowedSender,
  rejectPendingSender,
  setSenderAddressingOverride,
  senderMatchesAnyEntry,
} from '@/lib/server/connectors/pairing'

function setConnectorSenderList(connector: Connector, key: string, values: string[]): void {
  if (!connector.config) connector.config = {}
  if (values.length === 0) {
    delete connector.config[key]
    return
  }
  connector.config[key] = values.join(',')
}

function addConnectorSenderListEntry(connector: Connector, key: string, senderId: string): boolean {
  const normalized = normalizeSenderId(senderId)
  if (!normalized) return false
  const current = parseAllowFromCsv(connector.config?.[key])
  if (senderMatchesAnyEntry(normalized, current)) return false
  setConnectorSenderList(connector, key, [...current, normalized])
  return true
}

function removeConnectorSenderListEntry(connector: Connector, key: string, senderId: string): boolean {
  const normalized = normalizeSenderId(senderId)
  if (!normalized) return false
  const current = parseAllowFromCsv(connector.config?.[key])
  const next = current.filter((entry) => !senderMatchesAnyEntry(normalized, [entry]))
  if (next.length === current.length) return false
  setConnectorSenderList(connector, key, next)
  return true
}

function persistConnector(connector: Connector): void {
  connector.updatedAt = Date.now()
  upsertStoredItem('connectors', connector.id, connector)
}

function requireSenderId(body: Record<string, unknown>): string {
  const senderId = typeof body.senderId === 'string' ? body.senderId.trim() : ''
  if (!senderId) {
    throw new Error('senderId is required for this action')
  }
  return senderId
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  ensureDaemonStarted('api/connectors/[id]/access:get')
  const { id } = await params
  const connectors = loadConnectors()
  const connector = connectors[id]
  if (!connector) return notFound()

  const url = new URL(req.url)
  const senderId = url.searchParams.get('senderId')
  const senderIdAlt = url.searchParams.get('senderIdAlt')
  return NextResponse.json(buildConnectorAccessSnapshot({
    connector,
    senderId,
    senderIdAlt,
  }))
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  ensureDaemonStarted('api/connectors/[id]/access:put')
  const { id } = await params
  const connectors = loadConnectors()
  const connector = connectors[id]
  if (!connector) return notFound()

  try {
    const body = await req.json() as Record<string, unknown>
    const action = typeof body.action === 'string' ? body.action.trim().toLowerCase() as ConnectorAccessMutationAction : null
    if (!action) {
      return NextResponse.json({ error: 'Missing access action' }, { status: 400 })
    }

    let connectorChanged = false
    let responseSenderId = typeof body.senderId === 'string' ? body.senderId.trim() : ''
    const responseSenderIdAlt = typeof body.senderIdAlt === 'string' ? body.senderIdAlt.trim() : ''
    let summary = `Updated access controls for "${connector.name}".`

    switch (action) {
      case 'set_policy': {
        const rawPolicy = typeof body.dmPolicy === 'string' ? body.dmPolicy.trim() : ''
        if (!rawPolicy) {
          delete connector.config.dmPolicy
        } else {
          connector.config.dmPolicy = parsePairingPolicy(rawPolicy, 'open')
        }
        connectorChanged = true
        summary = `Updated DM policy for "${connector.name}".`
        break
      }
      case 'set_dm_addressing_mode': {
        const rawMode = typeof body.dmAddressingMode === 'string' ? body.dmAddressingMode.trim() : ''
        const nextMode = parseDmAddressingMode(rawMode || 'open', 'open')
        if (nextMode === 'open') delete connector.config.dmAddressingMode
        else connector.config.dmAddressingMode = nextMode
        connectorChanged = true
        summary = `Updated DM addressing mode for "${connector.name}" to ${nextMode}.`
        break
      }
      case 'allow_sender': {
        const senderId = requireSenderId(body)
        addAllowedSender(connector.id, senderId)
        connectorChanged = removeConnectorSenderListEntry(connector, 'denyFrom', senderId) || connectorChanged
        summary = `Allowed sender ${normalizeSenderId(senderId)} on "${connector.name}".`
        break
      }
      case 'remove_allowed_sender': {
        const senderId = requireSenderId(body)
        removeAllowedSender(connector.id, senderId)
        connectorChanged = removeConnectorSenderListEntry(connector, 'allowFrom', senderId) || connectorChanged
        summary = `Removed connector-managed access for ${normalizeSenderId(senderId)} on "${connector.name}".`
        break
      }
      case 'block_sender': {
        const senderId = requireSenderId(body)
        connectorChanged = addConnectorSenderListEntry(connector, 'denyFrom', senderId) || connectorChanged
        connectorChanged = removeConnectorSenderListEntry(connector, 'allowFrom', senderId) || connectorChanged
        removeAllowedSender(connector.id, senderId)
        rejectPendingSender(connector.id, senderId)
        const ownerSenderId = resolveConnectorOwnerSenderId(connector)
        if (ownerSenderId && senderMatchesAnyEntry(senderId, [ownerSenderId])) {
          delete connector.config.ownerSenderId
          connectorChanged = true
        }
        summary = `Blocked sender ${normalizeSenderId(senderId)} on "${connector.name}".`
        break
      }
      case 'unblock_sender': {
        const senderId = requireSenderId(body)
        connectorChanged = removeConnectorSenderListEntry(connector, 'denyFrom', senderId) || connectorChanged
        summary = `Removed sender ${normalizeSenderId(senderId)} from the deny list on "${connector.name}".`
        break
      }
      case 'approve_pairing': {
        if (typeof body.code === 'string' && body.code.trim()) {
          const approved = approvePairingCode(connector.id, body.code)
          if (!approved.ok) {
            return NextResponse.json({ error: approved.reason || 'Pairing approval failed.' }, { status: 400 })
          }
          if (approved.senderId) {
            responseSenderId = approved.senderId
            connectorChanged = removeConnectorSenderListEntry(connector, 'denyFrom', approved.senderId) || connectorChanged
          }
          summary = `Approved pairing on "${connector.name}".`
        } else {
          const senderId = requireSenderId(body)
          const approved = approvePendingSender(connector.id, senderId)
          if (!approved.ok) {
            return NextResponse.json({ error: approved.reason || 'Pairing approval failed.' }, { status: 400 })
          }
          connectorChanged = removeConnectorSenderListEntry(connector, 'denyFrom', senderId) || connectorChanged
          summary = `Approved pairing for ${normalizeSenderId(senderId)} on "${connector.name}".`
        }
        break
      }
      case 'reject_pairing': {
        const senderId = requireSenderId(body)
        rejectPendingSender(connector.id, senderId)
        summary = `Rejected pairing for ${normalizeSenderId(senderId)} on "${connector.name}".`
        break
      }
      case 'set_owner': {
        const senderId = requireSenderId(body)
        const normalized = normalizeSenderId(senderId)
        if (!normalized) {
          return NextResponse.json({ error: 'Could not normalize owner sender ID' }, { status: 400 })
        }
        connector.config.ownerSenderId = normalized
        connectorChanged = true
        connectorChanged = removeConnectorSenderListEntry(connector, 'denyFrom', normalized) || connectorChanged
        summary = `Set connector owner for "${connector.name}" to ${normalized}.`
        break
      }
      case 'clear_owner': {
        if (connector.config?.ownerSenderId) {
          delete connector.config.ownerSenderId
          connectorChanged = true
        }
        summary = `Cleared connector owner override for "${connector.name}".`
        break
      }
      case 'set_sender_dm_addressing': {
        const senderId = requireSenderId(body)
        const rawMode = typeof body.dmAddressingMode === 'string' ? body.dmAddressingMode.trim() : ''
        const nextMode = parseDmAddressingMode(rawMode || 'open', 'open')
        setSenderAddressingOverride(connector.id, senderId, nextMode)
        summary = `Updated DM addressing override for ${normalizeSenderId(senderId)} on "${connector.name}" to ${nextMode}.`
        break
      }
      case 'clear_sender_dm_addressing': {
        const senderId = requireSenderId(body)
        clearSenderAddressingOverride(connector.id, senderId)
        summary = `Cleared DM addressing override for ${normalizeSenderId(senderId)} on "${connector.name}".`
        break
      }
      default:
        return NextResponse.json({ error: `Unsupported access action: ${action}` }, { status: 400 })
    }

    if (connectorChanged) {
      persistConnector(connector)
    }

    logActivity({
      entityType: 'connector',
      entityId: connector.id,
      action: 'access-updated',
      actor: 'user',
      summary,
      detail: { action },
    })
    notify('connectors')

    return NextResponse.json<ConnectorAccessMutationResponse>({
      ok: true,
      snapshot: buildConnectorAccessSnapshot({
        connector,
        senderId: responseSenderId || null,
        senderIdAlt: responseSenderIdAlt || null,
      }),
    })
  } catch (err: unknown) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 400 })
  }
}
