import { Client, GatewayIntentBits, Events, Partials, AttachmentBuilder } from 'discord.js'
import fs from 'fs'
import path from 'path'
import type { Connector } from '@/types'
import type { PlatformConnector, ConnectorInstance, InboundMessage } from './types'
import { downloadInboundMediaToUpload, inferInboundMediaType } from './media'
import { isNoMessage } from './manager'

const discord: PlatformConnector = {
  async start(connector, botToken, onMessage): Promise<ConnectorInstance> {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel], // Required to receive DM events
    })

    // Optional: restrict to specific channels
    const allowedChannels = connector.config.channelIds
      ? connector.config.channelIds.split(',').map((s) => s.trim()).filter(Boolean)
      : null

    client.on(Events.MessageCreate, async (message) => {
      console.log(`[discord] Message from ${message.author.username} in ${message.channel.type === 1 ? 'DM' : '#' + ('name' in message.channel ? (message.channel as any).name : message.channelId)}: ${message.content.slice(0, 80)}`)
      // Ignore bot messages
      if (message.author.bot) return

      // Filter by allowed channels if configured
      if (allowedChannels && !allowedChannels.includes(message.channelId)) return

      const attachmentList = Array.from(message.attachments.values())
      const media: NonNullable<InboundMessage['media']> = []
      for (const attachment of attachmentList) {
        const mediaType = inferInboundMediaType(attachment.contentType || undefined, attachment.name || undefined)
        const sourceUrl = attachment.url || undefined
        if (sourceUrl) {
          try {
            const stored = await downloadInboundMediaToUpload({
              connectorId: connector.id,
              mediaType,
              url: sourceUrl,
              fileName: attachment.name || undefined,
              mimeType: attachment.contentType || undefined,
            })
            if (stored) {
              media.push(stored)
              continue
            }
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err)
            console.warn(`[discord] Media download failed (${attachment.name || 'file'}):`, errMsg)
          }
        }
        media.push({
          type: mediaType,
          fileName: attachment.name || undefined,
          mimeType: attachment.contentType || undefined,
          sizeBytes: attachment.size || undefined,
          url: sourceUrl,
        })
      }
      const firstImage = media.find((m) => m.type === 'image' && m.url)

      const inbound: InboundMessage = {
        platform: 'discord',
        channelId: message.channelId,
        channelName: 'name' in message.channel ? (message.channel as any).name : 'DM',
        senderId: message.author.id,
        senderName: message.author.displayName || message.author.username,
        text: message.content || (media.length > 0 ? '(media message)' : ''),
        imageUrl: firstImage?.url,
        media,
      }

      try {
        // Show typing indicator
        await message.channel.sendTyping()
        const response = await onMessage(inbound)

        if (isNoMessage(response)) return

        // Discord has a 2000 char limit per message
        if (response.length <= 2000) {
          await message.channel.send(response)
        } else {
          // Split into chunks
          const chunks = response.match(/[\s\S]{1,1990}/g) || [response]
          for (const chunk of chunks) {
            await message.channel.send(chunk)
          }
        }
      } catch (err: any) {
        console.error(`[discord] Error handling message:`, err.message)
        try {
          await message.reply('Sorry, I encountered an error processing your message.')
        } catch { /* ignore */ }
      }
    })

    await client.login(botToken)
    console.log(`[discord] Bot logged in as ${client.user?.tag}`)

    return {
      connector,
      isAlive() {
        return client.isReady()
      },
      async sendMessage(channelId, text, options) {
        const channel = await client.channels.fetch(channelId)
        if (!channel || !('send' in channel) || typeof (channel as any).send !== 'function') {
          throw new Error(`Cannot send to channel ${channelId}`)
        }

        const files: AttachmentBuilder[] = []
        if (options?.mediaPath) {
          if (!fs.existsSync(options.mediaPath)) throw new Error(`File not found: ${options.mediaPath}`)
          files.push(new AttachmentBuilder(options.mediaPath, { name: options.fileName || path.basename(options.mediaPath) }))
        } else if (options?.imageUrl) {
          files.push(new AttachmentBuilder(options.imageUrl, { name: options.fileName || 'image.png' }))
        } else if (options?.fileUrl) {
          files.push(new AttachmentBuilder(options.fileUrl, { name: options.fileName || 'attachment' }))
        }

        const content = options?.caption || text || undefined
        const msg = await (channel as any).send({
          content: content || (files.length ? undefined : '(empty)'),
          files: files.length ? files : undefined,
        })
        return { messageId: msg.id }
      },
      async stop() {
        client.destroy()
        console.log(`[discord] Bot disconnected`)
      },
    }
  },
}

export default discord
