import type { PlatformConnector, ConnectorInstance, InboundMessage } from './types'
import { isNoMessage } from './manager'

const googlechat: PlatformConnector = {
  async start(connector, botToken, onMessage): Promise<ConnectorInstance> {
    const pkg = 'googleapis'
    const { google } = await import(/* webpackIgnore: true */ pkg)

    // Parse service account credentials from botToken
    let credentials: any
    try {
      credentials = JSON.parse(botToken)
    } catch {
      throw new Error('botToken must be a valid JSON service account key')
    }

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/chat.bot'],
    })

    const chat = google.chat({ version: 'v1', auth })

    // Optional: restrict to specific spaces
    const allowedSpaces = connector.config.spaceIds
      ? connector.config.spaceIds.split(',').map((s: string) => s.trim()).filter(Boolean)
      : null

    const handlerKey = `__swarmclaw_googlechat_handler_${connector.id}__`
    let stopped = false

    console.log(`[googlechat] Bot authenticated via service account`)
    if (allowedSpaces) {
      console.log(`[googlechat] Filtering to spaces: ${allowedSpaces.join(', ')}`)
    }
    console.log(`[googlechat] Inbound webhook endpoint: /api/connectors/${connector.id}/webhook`)

    function cleanInboundText(raw: unknown): string {
      const txt = typeof raw === 'string' ? raw : ''
      // Google Chat mentions often look like <users/123456789>
      return txt.replace(/<users\/[^>]+>/g, '').trim()
    }

    async function processWebhookEvent(event: any): Promise<Record<string, unknown>> {
      if (stopped) throw new Error('Connector is stopped')

      const msg = event?.message
      if (!msg) return {}

      const spaceName: string = msg?.space?.name || event?.space?.name || ''
      if (allowedSpaces && !allowedSpaces.some((s) => spaceName.includes(s))) {
        return {}
      }

      const rawText = msg?.argumentText || msg?.text || ''
      const text = cleanInboundText(rawText)
      if (!text) return {}

      const sender = msg?.sender || event?.user || {}
      const senderName = sender?.displayName || sender?.name || 'Google Chat User'
      const senderId = sender?.name || ''
      const inbound: InboundMessage = {
        platform: 'googlechat',
        channelId: spaceName || (msg?.thread?.name || 'space:unknown'),
        channelName: msg?.space?.displayName || spaceName || 'Google Chat',
        senderId,
        senderName,
        text,
      }

      const response = await onMessage(inbound)
      if (!response || isNoMessage(response)) return {}
      return { text: response }
    }

    ;(globalThis as any)[handlerKey] = processWebhookEvent

    return {
      connector,
      async sendMessage(channelId, text) {
        if (stopped) throw new Error('Connector is stopped')

        // channelId should be a space name like "spaces/AAAA"
        const parent = channelId.startsWith('spaces/') ? channelId : `spaces/${channelId}`

        if (allowedSpaces && !allowedSpaces.some((s) => parent.includes(s))) {
          throw new Error(`Space ${parent} not in allowed spaceIds`)
        }

        const res = await chat.spaces.messages.create({
          parent,
          requestBody: { text },
        })
        return { messageId: res.data.name || undefined }
      },
      async stop() {
        stopped = true
        delete (globalThis as any)[handlerKey]
        console.log(`[googlechat] Bot disconnected`)
      },
    }
  },
}

export default googlechat
