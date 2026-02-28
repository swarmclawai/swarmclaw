import type { PlatformConnector, ConnectorInstance } from './types'

const googlechat: PlatformConnector = {
  async start(connector, botToken, _onMessage): Promise<ConnectorInstance> {
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

    // Google Chat requires a webhook or Pub/Sub for real-time inbound messages.
    // This connector supports outbound messaging. For inbound messages, configure
    // a webhook endpoint at /api/connectors/[id]/webhook that POSTs events here.
    // Polling is not supported by the Google Chat API for bot messages.
    let stopped = false

    console.log(`[googlechat] Bot authenticated via service account`)
    if (allowedSpaces) {
      console.log(`[googlechat] Filtering to spaces: ${allowedSpaces.join(', ')}`)
    }
    console.log(`[googlechat] Note: Inbound messages require a webhook or Pub/Sub subscription. This connector supports outbound sends.`)

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
        console.log(`[googlechat] Bot disconnected`)
      },
    }
  },
}

export default googlechat
