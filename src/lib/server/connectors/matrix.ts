import fs from 'fs'
import path from 'path'
import { DATA_DIR } from '../data-dir'
import type { PlatformConnector, ConnectorInstance, InboundMessage } from './types'
import { isNoMessage } from './manager'

const matrix: PlatformConnector = {
  async start(connector, botToken, onMessage): Promise<ConnectorInstance> {
    const pkg = 'matrix-bot-sdk'
    const { MatrixClient, SimpleFsStorageProvider, AutojoinRoomsMixin } = await import(/* webpackIgnore: true */ pkg)

    const homeserverUrl = connector.config.homeserverUrl
    if (!homeserverUrl) throw new Error('Missing homeserverUrl in connector config')

    // Ensure storage directory exists
    const storageDir = path.join(DATA_DIR, 'matrix-storage', connector.id)
    fs.mkdirSync(storageDir, { recursive: true })

    const storage = new SimpleFsStorageProvider(path.join(storageDir, 'bot.json'))
    const client = new MatrixClient(homeserverUrl, botToken, storage)

    AutojoinRoomsMixin.setupOnClient(client)

    // Optional: restrict to specific rooms
    const allowedRooms = connector.config.roomIds
      ? connector.config.roomIds.split(',').map((s: string) => s.trim()).filter(Boolean)
      : null

    client.on('room.message', async (roomId: string, event: any) => {
      // Ignore own messages
      const userId = await client.getUserId()
      if (event.sender === userId) return

      // Ignore non-text messages and edits
      if (!event.content?.body) return
      if (event.content['m.relates_to']?.rel_type === 'm.replace') return

      // Filter by allowed rooms if configured
      if (allowedRooms && !allowedRooms.includes(roomId)) return

      const inbound: InboundMessage = {
        platform: 'matrix',
        channelId: roomId,
        channelName: roomId,
        senderId: event.sender,
        senderName: event.sender.split(':')[0].replace('@', '') || event.sender,
        text: event.content.body || '',
      }

      try {
        const response = await onMessage(inbound)
        if (isNoMessage(response)) return
        await client.sendText(roomId, response)
      } catch (err: any) {
        console.error(`[matrix] Error handling message:`, err.message)
        try {
          await client.sendText(roomId, 'Sorry, I encountered an error processing your message.')
        } catch { /* ignore */ }
      }
    })

    await client.start()
    console.log(`[matrix] Bot connected to ${homeserverUrl}`)

    return {
      connector,
      async sendMessage(channelId, text) {
        await client.sendText(channelId, text)
      },
      async stop() {
        client.stop()
        console.log(`[matrix] Bot disconnected`)
      },
    }
  },
}

export default matrix
