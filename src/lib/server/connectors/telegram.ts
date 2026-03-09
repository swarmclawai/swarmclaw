import { Bot, InputFile } from 'grammy'
import fs from 'fs'
import path from 'path'
import type { Connector } from '@/types'
import type { PlatformConnector, ConnectorInstance, InboundMessage, InboundMediaType } from './types'
import { normalizeConnectorIngressResult } from './types'
import { downloadInboundMediaToUpload, inferInboundMediaType, mimeFromPath, isImageMime, isAudioMime } from './media'
import { getConnectorReplySendOptions, isNoMessage, recordConnectorOutboundDelivery } from './manager'

const telegram: PlatformConnector = {
  async start(connector, botToken, onMessage): Promise<ConnectorInstance> {
    const bot = new Bot(botToken)
    let botUsername = ''

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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = ctx.message as any
      const text = raw.text || raw.caption || ''

      // Filter out Telegram service/system messages (read receipts, reactions, etc.)
      // that appear as short bracketed strings like [rr], [e], [read] etc.
      const hasMedia = raw.photo || raw.video || raw.audio || raw.voice || raw.document || raw.animation
      if (!hasMedia && /^\[.{1,5}\]$/.test(text.trim())) {
        console.log(`[telegram] Ignoring system event from ${ctx.from.first_name}: ${text}`)
        return
      }

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
        isGroup: ctx.chat.type !== 'private',
        messageId: String(raw.message_id),
        replyToMessageId: raw.reply_to_message?.message_id ? String(raw.reply_to_message.message_id) : undefined,
        threadId: raw.message_thread_id ? String(raw.message_thread_id) : undefined,
        mentionsBot: !!(botUsername && text && new RegExp(`@${botUsername}\\b`, 'i').test(String(text))),
        imageUrl: media.find((m) => m.type === 'image')?.url,
        media,
      }

      try {
        await ctx.api.sendChatAction(ctx.chat.id, 'typing')
        const routeResult = normalizeConnectorIngressResult(await onMessage(inbound))
        if (routeResult.managerHandled || routeResult.delivery === 'silent') return
        const response = routeResult.visibleText

        const replyOptions = getConnectorReplySendOptions({ connectorId: connector.id, inbound })
        const baseOptions: Record<string, unknown> = {}
        if (replyOptions.replyToMessageId) {
          baseOptions.reply_parameters = { message_id: Number(replyOptions.replyToMessageId) }
        }
        if (replyOptions.threadId) {
          baseOptions.message_thread_id = Number(replyOptions.threadId)
        }

        let lastMessageId: string | undefined

        // Telegram has a 4096 char limit
        if (response.length <= 4096) {
          const sent = await ctx.api.sendMessage(ctx.chat.id, response, baseOptions as any)
          lastMessageId = String(sent.message_id)
        } else {
          const chunks = response.match(/[\s\S]{1,4090}/g) || [response]
          for (let i = 0; i < chunks.length; i += 1) {
            const sent = await ctx.api.sendMessage(ctx.chat.id, chunks[i], (i === 0 ? baseOptions : {}) as any)
            lastMessageId = String(sent.message_id)
          }
        }
        await recordConnectorOutboundDelivery({
          connectorId: connector.id,
          inbound,
          messageId: lastMessageId,
          state: 'sent',
        })
      } catch (err: any) {
        console.error(`[telegram] Error handling message:`, err.message)
        try {
          await ctx.reply('Sorry, I encountered an error processing your message.')
        } catch { /* ignore */ }
      }
    })

    // Track whether the bot is actively polling
    let botRunning = true

    const instance: ConnectorInstance = {
      connector,
      isAlive() {
        return botRunning
      },
      async sendMessage(channelId, text, options) {
        const chatId = channelId
        const caption = options?.caption || text || undefined
        const extra: Record<string, unknown> = {}
        if (options?.replyToMessageId) {
          extra.reply_parameters = { message_id: Number(options.replyToMessageId) }
        }
        if (options?.threadId) {
          extra.message_thread_id = Number(options.threadId)
        }

        // Local file
        if (options?.mediaPath) {
          if (!fs.existsSync(options.mediaPath)) throw new Error(`File not found: ${options.mediaPath}`)
          const mime = options.mimeType || mimeFromPath(options.mediaPath)
          const inputFile = new InputFile(options.mediaPath, options.fileName || path.basename(options.mediaPath))
          if (isImageMime(mime)) {
            const msg = await bot.api.sendPhoto(chatId, inputFile, { caption, ...(extra as any) })
            return { messageId: String(msg.message_id) }
          } else if (isAudioMime(mime)) {
            const msg = options?.ptt
              ? await bot.api.sendVoice(chatId, inputFile, { caption, ...(extra as any) })
              : await bot.api.sendAudio(chatId, inputFile, { caption, ...(extra as any) })
            return { messageId: String(msg.message_id) }
          } else {
            const msg = await bot.api.sendDocument(chatId, inputFile, { caption, ...(extra as any) })
            return { messageId: String(msg.message_id) }
          }
        }
        // URL-based image
        if (options?.imageUrl) {
          const msg = await bot.api.sendPhoto(chatId, options.imageUrl, { caption, ...(extra as any) })
          return { messageId: String(msg.message_id) }
        }
        // URL-based file
        if (options?.fileUrl) {
          const mime = options.mimeType || ''
          const msg = isAudioMime(mime)
            ? options?.ptt
              ? await bot.api.sendVoice(chatId, options.fileUrl, { caption, ...(extra as any) })
              : await bot.api.sendAudio(chatId, options.fileUrl, { caption, ...(extra as any) })
            : await bot.api.sendDocument(chatId, options.fileUrl, { caption, ...(extra as any) })
          return { messageId: String(msg.message_id) }
        }
        // Text only
        const payload = text || caption || ''
        if (payload.length <= 4096) {
          const msg = await bot.api.sendMessage(chatId, payload, extra as any)
          return { messageId: String(msg.message_id) }
        }
        const chunks = payload.match(/[\s\S]{1,4090}/g) || [payload]
        let lastId: string | undefined
        for (let i = 0; i < chunks.length; i += 1) {
          const msg = await bot.api.sendMessage(chatId, chunks[i], (i === 0 ? extra : {}) as any)
          lastId = String(msg.message_id)
        }
        return { messageId: lastId }
      },
      async sendReaction(channelId, messageId, emoji) {
        const fn = (bot.api as any).setMessageReaction
        if (typeof fn !== 'function') return
        await fn.call(bot.api, channelId, Number(messageId), [{ type: 'emoji', emoji }])
      },
      async editMessage(channelId, messageId, newText) {
        await bot.api.editMessageText(channelId, Number(messageId), newText)
      },
      async deleteMessage(channelId, messageId) {
        await bot.api.deleteMessage(channelId, Number(messageId))
      },
      async pinMessage(channelId, messageId) {
        await bot.api.pinChatMessage(channelId, Number(messageId))
      },
      async sendTyping(channelId) {
        await bot.api.sendChatAction(channelId, 'typing')
      },
      async stop() {
        botRunning = false
        await bot.stop()
        console.log(`[telegram] Bot stopped`)
      },
    }

    // Start polling — not awaited (runs in background)
    bot.start({
      allowed_updates: ['message', 'edited_message'],
      onStart: (botInfo) => {
        botUsername = botInfo.username || ''
        console.log(`[telegram] Bot started as @${botInfo.username} — polling for updates`)
      },
    }).catch((err: unknown) => {
      botRunning = false
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(`[telegram] Polling stopped with error:`, errMsg)
      instance.onCrash?.(`Polling stopped: ${errMsg}`)
    })

    return instance
  },
}

export default telegram
