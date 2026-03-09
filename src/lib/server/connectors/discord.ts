import { Client, GatewayIntentBits, Events, Partials, AttachmentBuilder } from 'discord.js'
import fs from 'fs'
import path from 'path'
import type { Connector } from '@/types'
import type { PlatformConnector, ConnectorInstance, InboundMessage, InboundThreadHistoryEntry } from './types'
import { normalizeConnectorIngressResult } from './types'
import { downloadInboundMediaToUpload, inferInboundMediaType } from './media'
import { getConnectorReplySendOptions, isNoMessage, recordConnectorOutboundDelivery } from './manager'

function buildDiscordThreadTitle(params: {
  threadName?: string
  channelName?: string
  starterText?: string
  fallbackId: string
}): string {
  const threadName = String(params.threadName || '').trim()
  if (threadName) return threadName
  const snippet = String(params.starterText || '').replace(/\s+/g, ' ').trim().slice(0, 56)
  if (snippet) return `${params.channelName || 'Discord'} · ${snippet}`
  return `${params.channelName || 'Discord'} thread ${params.fallbackId}`
}

function discordSenderName(message: any): string {
  return message?.member?.displayName
    || message?.author?.globalName
    || message?.author?.displayName
    || message?.author?.username
    || 'Unknown'
}

async function hydrateDiscordThreadContext(message: any, inbound: InboundMessage): Promise<void> {
  const channel = message.channel as any
  const isThread = typeof channel?.isThread === 'function' && channel.isThread()

  try {
    if (isThread) {
      const starter = typeof channel.fetchStarterMessage === 'function'
        ? await channel.fetchStarterMessage().catch(() => null)
        : null
      const historyCollection = channel?.messages && typeof channel.messages.fetch === 'function'
        ? await channel.messages.fetch({ limit: 8, before: message.id }).catch(() => null)
        : null
      const historyMessages = historyCollection
        ? Array.from(historyCollection.values()).sort((a: any, b: any) => (a.createdTimestamp || 0) - (b.createdTimestamp || 0))
        : []
      const history: InboundThreadHistoryEntry[] = historyMessages
        .filter((item: any) => item?.content?.trim())
        .map((item: any) => ({
          role: (item.author?.bot ? 'assistant' : 'user') as 'assistant' | 'user',
          senderName: discordSenderName(item),
          text: item.content,
          messageId: item.id,
        }))

      inbound.threadParentChannelId = channel?.parentId || undefined
      inbound.threadParentChannelName = channel?.parent?.name || undefined
      inbound.threadStarterText = starter?.content?.trim() || undefined
      inbound.threadStarterSenderName = starter ? discordSenderName(starter) : undefined
      inbound.threadTitle = buildDiscordThreadTitle({
        threadName: channel?.name,
        channelName: inbound.threadParentChannelName || inbound.channelName,
        starterText: inbound.threadStarterText,
        fallbackId: inbound.threadId || inbound.channelId,
      })
      inbound.threadPersonaLabel = inbound.threadTitle
      inbound.threadHistory = history.length ? history : undefined
      return
    }

    if (message.reference?.messageId && typeof message.fetchReference === 'function') {
      const starter = await message.fetchReference().catch(() => null)
      if (!starter) return
      inbound.threadStarterText = starter.content?.trim() || undefined
      inbound.threadStarterSenderName = discordSenderName(starter)
      inbound.threadParentChannelId = inbound.channelId
      inbound.threadParentChannelName = inbound.channelName
      inbound.threadTitle = buildDiscordThreadTitle({
        channelName: inbound.channelName,
        starterText: inbound.threadStarterText,
        fallbackId: starter.id || inbound.replyToMessageId || inbound.channelId,
      })
      inbound.threadPersonaLabel = inbound.threadTitle
      inbound.threadHistory = [{
        role: (starter.author?.bot ? 'assistant' : 'user') as 'assistant' | 'user',
        senderName: discordSenderName(starter),
        text: starter.content || '',
        messageId: starter.id,
      }].filter((entry) => entry.text.trim().length > 0)
    }
  } catch (err: unknown) {
    console.warn(`[discord] Thread context bootstrap failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

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

    async function resolveTextChannel(targetChannelId: string) {
      const channel = await client.channels.fetch(targetChannelId)
      if (!channel || !('send' in channel) || typeof (channel as any).send !== 'function') {
        throw new Error(`Cannot send to channel ${targetChannelId}`)
      }
      return channel as any
    }

    async function resolveChannelMessage(targetChannelId: string, messageId: string) {
      const channel = await resolveTextChannel(targetChannelId)
      const messages = (channel as any).messages
      if (!messages || typeof messages.fetch !== 'function') {
        throw new Error(`Channel ${targetChannelId} does not support message actions`)
      }
      return await messages.fetch(messageId)
    }

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
        isGroup: message.channel.type !== 1,
        messageId: message.id,
        mentionsBot: client.user ? message.mentions.users.has(client.user.id) : false,
        imageUrl: firstImage?.url,
        media,
        replyToMessageId: message.reference?.messageId || undefined,
        threadId: typeof (message.channel as any).isThread === 'function' && (message.channel as any).isThread()
          ? message.channelId
          : undefined,
      }
      await hydrateDiscordThreadContext(message, inbound)

      try {
        // Show typing indicator
        await message.channel.sendTyping()
        const routeResult = normalizeConnectorIngressResult(await onMessage(inbound))
        if (routeResult.managerHandled || routeResult.delivery === 'silent') return
        const response = routeResult.visibleText

        const replyOptions = getConnectorReplySendOptions({ connectorId: connector.id, inbound })
        const targetChannelId = replyOptions.threadId || inbound.channelId
        const sendChunk = async (chunk: string, isFirstChunk: boolean) => {
          const channel = await resolveTextChannel(targetChannelId)
          const payload: Record<string, unknown> = {
            content: chunk,
            allowedMentions: { repliedUser: false },
          }
          if (isFirstChunk && replyOptions.replyToMessageId) {
            payload.reply = {
              messageReference: replyOptions.replyToMessageId,
              failIfNotExists: false,
            }
          }
          const sent = await channel.send(payload)
          return String(sent.id || '')
        }

        let lastMessageId: string | undefined
        // Discord has a 2000 char limit per message
        if (response.length <= 2000) {
          lastMessageId = await sendChunk(response, true)
        } else {
          // Split into chunks
          const chunks = response.match(/[\s\S]{1,1990}/g) || [response]
          for (let i = 0; i < chunks.length; i += 1) {
            lastMessageId = await sendChunk(chunks[i], i === 0)
          }
        }
        await recordConnectorOutboundDelivery({
          connectorId: connector.id,
          inbound,
          messageId: lastMessageId,
          state: 'sent',
        })
      } catch (err: any) {
        console.error(`[discord] Error handling message:`, err.message)
        try {
          await message.reply('Sorry, I encountered an error processing your message.')
        } catch { /* ignore */ }
      }
    })

    await client.login(botToken)
    console.log(`[discord] Bot logged in as ${client.user?.tag}`)

    const instance: ConnectorInstance = {
      connector,
      isAlive() {
        return client.isReady()
      },
      async sendMessage(channelId, text, options) {
        const targetChannelId = options?.threadId?.trim() || channelId
        const channel = await resolveTextChannel(targetChannelId)

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
        const payload: Record<string, unknown> = {
          content: content || (files.length ? undefined : '(empty)'),
          files: files.length ? files : undefined,
        }
        if (options?.replyToMessageId) {
          payload.reply = {
            messageReference: options.replyToMessageId,
            failIfNotExists: false,
          }
        }

        const msg = await channel.send(payload)
        return { messageId: msg.id }
      },
      async sendReaction(channelId, messageId, emoji) {
        const message = await resolveChannelMessage(channelId, messageId)
        await message.react(emoji)
      },
      async editMessage(channelId, messageId, newText) {
        const message = await resolveChannelMessage(channelId, messageId)
        await message.edit(newText)
      },
      async deleteMessage(channelId, messageId) {
        const message = await resolveChannelMessage(channelId, messageId)
        await message.delete()
      },
      async pinMessage(channelId, messageId) {
        const message = await resolveChannelMessage(channelId, messageId)
        await message.pin()
      },
      async sendTyping(channelId, options) {
        const targetChannelId = options?.threadId?.trim() || channelId
        const channel = await resolveTextChannel(targetChannelId)
        if (typeof channel.sendTyping === 'function') {
          await channel.sendTyping()
        }
      },
      async stop() {
        client.destroy()
        console.log(`[discord] Bot disconnected`)
      },
    }

    // Terminal disconnect — discord.js won't auto-reconnect for these
    client.once('invalidated', () => {
      instance.onCrash?.('Discord session invalidated')
    })
    client.on('shardError', (error) => {
      console.error(`[discord] Shard error:`, error.message)
    })

    return instance
  },
}

export default discord
