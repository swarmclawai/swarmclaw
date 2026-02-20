import { Bot } from 'grammy'
import type { Connector } from '@/types'
import type { PlatformConnector, ConnectorInstance, InboundMessage, InboundMediaType } from './types'
import { downloadInboundMediaToUpload, inferInboundMediaType } from './media'
import { isNoMessage } from './manager'

const telegram: PlatformConnector = {
  async start(connector, botToken, onMessage): Promise<ConnectorInstance> {
    const bot = new Bot(botToken)

    // Optional: restrict to specific chat IDs
    const allowedChats = connector.config.chatIds
      ? connector.config.chatIds.split(',').map((s) => s.trim()).filter(Boolean)
      : null

    // Log all errors
    bot.catch((err) => {
      console.error(`[telegram] Bot error:`, err.message || err)
    })

    // Delete any existing webhook so long polling works
    await bot.api.deleteWebhook().catch((err) => {
      console.error('[telegram] Failed to delete webhook:', err.message)
    })

    // Log all incoming updates for debugging
    bot.use(async (ctx, next) => {
      console.log(`[telegram] Update received: chat=${ctx.chat?.id}, from=${ctx.from?.first_name}, hasText=${!!ctx.message?.text}`)
      await next()
    })

    // Handle /start command (required for new conversations)
    bot.command('start', async (ctx) => {
      console.log(`[telegram] /start from ${ctx.from?.first_name} (chat=${ctx.chat.id})`)
      await ctx.reply('Hello! I\'m ready to chat. Send me a message.')
    })

    bot.on('message', async (ctx) => {
      if (!ctx.message || !ctx.from || !ctx.chat) return
      const chatId = String(ctx.chat.id)
      const raw = ctx.message as any
      const text = raw.text || raw.caption || ''
      console.log(`[telegram] Message from ${ctx.from.first_name} (chat=${chatId}): ${String(text).slice(0, 80)}`)

      // Filter by allowed chats if configured
      if (allowedChats && !allowedChats.includes(chatId)) {
        console.log(`[telegram] Skipping — chat ${chatId} not in allowed list: ${allowedChats.join(',')}`)
        return
      }

      const media: NonNullable<InboundMessage['media']> = []
      const mediaCandidates: Array<{ fileId: string; mimeType?: string; fileName?: string; type: InboundMediaType }> = []

      if (Array.isArray(raw.photo) && raw.photo.length > 0) {
        const largest = raw.photo[raw.photo.length - 1]
        if (largest?.file_id) mediaCandidates.push({ fileId: largest.file_id, type: 'image' })
      }
      if (raw.video?.file_id) {
        mediaCandidates.push({
          fileId: raw.video.file_id,
          type: 'video',
          mimeType: raw.video.mime_type || undefined,
          fileName: raw.video.file_name || undefined,
        })
      }
      if (raw.audio?.file_id) {
        mediaCandidates.push({
          fileId: raw.audio.file_id,
          type: 'audio',
          mimeType: raw.audio.mime_type || undefined,
          fileName: raw.audio.file_name || undefined,
        })
      }
      if (raw.voice?.file_id) {
        mediaCandidates.push({
          fileId: raw.voice.file_id,
          type: 'audio',
          mimeType: raw.voice.mime_type || 'audio/ogg',
          fileName: 'voice.ogg',
        })
      }
      if (raw.document?.file_id) {
        mediaCandidates.push({
          fileId: raw.document.file_id,
          type: inferInboundMediaType(raw.document.mime_type || undefined, raw.document.file_name || undefined, 'document'),
          mimeType: raw.document.mime_type || undefined,
          fileName: raw.document.file_name || undefined,
        })
      }
      if (raw.animation?.file_id) {
        mediaCandidates.push({
          fileId: raw.animation.file_id,
          type: 'video',
          mimeType: raw.animation.mime_type || undefined,
          fileName: raw.animation.file_name || undefined,
        })
      }

      for (const m of mediaCandidates) {
        try {
          const file = await bot.api.getFile(m.fileId)
          if (!file?.file_path) throw new Error('Missing Telegram file_path')
          const sourceUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`
          const stored = await downloadInboundMediaToUpload({
            connectorId: connector.id,
            mediaType: m.type,
            url: sourceUrl,
            fileName: m.fileName,
            mimeType: m.mimeType,
          })
          if (stored) media.push(stored)
        } catch (err: any) {
          console.warn(`[telegram] Failed to fetch media ${m.fileId}:`, err?.message || String(err))
          media.push({
            type: m.type,
            fileName: m.fileName,
            mimeType: m.mimeType,
          })
        }
      }

      const inbound: InboundMessage = {
        platform: 'telegram',
        channelId: chatId,
        channelName: ctx.chat.type === 'private'
          ? `DM:${ctx.from.first_name}`
          : ('title' in ctx.chat ? ctx.chat.title : chatId),
        senderId: String(ctx.from.id),
        senderName: ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : ''),
        text: text || (media.length > 0 ? '(media message)' : ''),
        imageUrl: media.find((m) => m.type === 'image')?.url,
        media,
      }

      try {
        await ctx.api.sendChatAction(ctx.chat.id, 'typing')
        const response = await onMessage(inbound)

        if (isNoMessage(response)) return

        // Telegram has a 4096 char limit
        if (response.length <= 4096) {
          await ctx.reply(response)
        } else {
          const chunks = response.match(/[\s\S]{1,4090}/g) || [response]
          for (const chunk of chunks) {
            await ctx.api.sendMessage(ctx.chat.id, chunk)
          }
        }
      } catch (err: any) {
        console.error(`[telegram] Error handling message:`, err.message)
        try {
          await ctx.reply('Sorry, I encountered an error processing your message.')
        } catch { /* ignore */ }
      }
    })

    // Start polling — not awaited (runs in background)
    bot.start({
      allowed_updates: ['message', 'edited_message'],
      onStart: (botInfo) => {
        console.log(`[telegram] Bot started as @${botInfo.username} — polling for updates`)
      },
    }).catch((err) => {
      console.error(`[telegram] Polling stopped with error:`, err.message || err)
    })

    return {
      connector,
      async stop() {
        await bot.stop()
        console.log(`[telegram] Bot stopped`)
      },
    }
  },
}

export default telegram
