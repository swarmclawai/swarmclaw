import type { PlatformConnector, ConnectorInstance, InboundMessage } from './types'
import { isNoMessage } from './manager'

const teams: PlatformConnector = {
  async start(connector, botToken, onMessage): Promise<ConnectorInstance> {
    const pkg = 'botbuilder'
    const { BotFrameworkAdapter, TurnContext } = await import(/* webpackIgnore: true */ pkg)

    const appId = connector.config.appId
    if (!appId) throw new Error('Missing appId in connector config')

    const adapter = new BotFrameworkAdapter({
      appId,
      appPassword: botToken,
    })

    adapter.onTurnError = async (_context: unknown, error: Error) => {
      console.error(`[teams] Turn error:`, error.message)
    }

    // Store conversation references for proactive messaging
    const conversationReferences = new Map<string, any>()
    let stopped = false

    // Process incoming activities — called from the webhook endpoint.
    // We use processActivityDirect so this works from Next.js route handlers.
    const processActivity = async (activity: any) => {
      if (stopped) return
      await adapter.processActivityDirect(activity, async (context: any) => {
        if (context.activity.type !== 'message') return
        if (!context.activity.text) return

        // Save conversation reference for proactive messaging
        const ref = TurnContext.getConversationReference(context.activity)
        const convId = context.activity.conversation?.id || ''
        conversationReferences.set(convId, ref)

        const inbound: InboundMessage = {
          platform: 'teams',
          channelId: convId,
          channelName: context.activity.conversation?.name || convId,
          senderId: context.activity.from?.id || '',
          senderName: context.activity.from?.name || 'Unknown',
          text: context.activity.text || '',
        }

        try {
          const response = await onMessage(inbound)
          if (isNoMessage(response)) return
          await context.sendActivity(response)
        } catch (err: any) {
          console.error(`[teams] Error handling message:`, err.message)
          try {
            await context.sendActivity('Sorry, I encountered an error processing your message.')
          } catch { /* ignore */ }
        }
      })
    }

    // Store processActivity on globalThis so the webhook route can access it.
    const handlerKey = `__swarmclaw_teams_handler_${connector.id}__`
    ;(globalThis as any)[handlerKey] = processActivity

    console.log(`[teams] Bot registered (appId: ${appId})`)
    console.log(`[teams] Configure your bot's messaging endpoint to POST to /api/connectors/${connector.id}/webhook`)

    return {
      connector,
      async sendMessage(channelId, text) {
        if (stopped) throw new Error('Connector is stopped')

        const ref = conversationReferences.get(channelId)
        if (!ref) {
          throw new Error(`No conversation reference found for ${channelId}. The bot must receive a message first.`)
        }

        let messageId: string | undefined
        await adapter.continueConversation(ref, async (context: any) => {
          const sent = await context.sendActivity(text)
          messageId = sent?.id
        })
        return { messageId }
      },
      async stop() {
        stopped = true
        delete (globalThis as any)[handlerKey]
        conversationReferences.clear()
        console.log(`[teams] Bot disconnected`)
      },
    }
  },
}

export default teams
