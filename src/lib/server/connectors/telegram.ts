import { Bot } from 'grammy'
import type { Connector } from '@/types'
import type { PlatformConnector, ConnectorInstance, InboundMessage } from './types'

const telegram: PlatformConnector = {
  async start(connector, botToken, onMessage): Promise<ConnectorInstance> {
    const bot = new Bot(botToken)

    // Optional: restrict to specific chat IDs
    const allowedChats = connector.config.chatIds
      ? connector.config.chatIds.split(',').map((s) => s.trim()).filter(Boolean)
      : null

    bot.on('message:text', async (ctx) => {
      const chatId = String(ctx.chat.id)

      // Filter by allowed chats if configured
      if (allowedChats && !allowedChats.includes(chatId)) return

      const inbound: InboundMessage = {
        platform: 'telegram',
        channelId: chatId,
        channelName: ctx.chat.type === 'private'
          ? `DM:${ctx.from.first_name}`
          : ('title' in ctx.chat ? ctx.chat.title : chatId),
        senderId: String(ctx.from.id),
        senderName: ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : ''),
        text: ctx.message.text,
      }

      try {
        await ctx.api.sendChatAction(ctx.chat.id, 'typing')
        const response = await onMessage(inbound)

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

    // Start polling
    bot.start({
      onStart: (botInfo) => {
        console.log(`[telegram] Bot started as @${botInfo.username}`)
      },
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
