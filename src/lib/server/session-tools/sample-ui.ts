import { z } from 'zod'
import { tool } from '@langchain/core/tools'
import { getPluginManager } from '../plugins'
import type { Plugin, PluginHooks } from '@/types'
import { normalizeToolInputArgs } from './normalize-tool-args'

/**
 * Sample UI Extension Plugin
 * This demonstrates how a plugin can add a sidebar item, 
 * a chat header widget, and a custom message type.
 */
const SampleUIPlugin: Plugin = {
  name: 'Sample UI',
  description: 'Demonstration of plugin-driven UI: Sidebar, Header, and Chat.',
  ui: {
    sidebarItems: [
      {
        id: 'sample-dashboard',
        label: 'Plugin View',
        href: 'https://openclaw.ai',
        position: 'top'
      }
    ],
    headerWidgets: [
      {
        id: 'sample-status',
        label: '🔌 Plugin Active'
      }
    ],
    chatInputActions: [
      {
        id: 'sample-action',
        label: 'Quick Scan',
        tooltip: 'Run a sample system scan',
        action: 'message',
        value: 'Please perform a quick system scan and report the health.'
      }
    ]
  },
  hooks: {
    transformInboundMessage: async ({ text }) => {
      console.log('[plugin:sample_ui] Transforming inbound message')
      return text // No-op but demonstrates hook
    },
    transformOutboundMessage: async ({ text }) => {
      console.log('[plugin:sample_ui] Transforming outbound message')
      return text + '\n\n*-- Sent via Sample UI Plugin --*'
    }
  } as PluginHooks,
  tools: [
    {
      name: 'show_plugin_card',
      description: 'Trigger a rich UI card in the chat using the plugin-ui message kind.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['title', 'content']
      },
      execute: async (args) => {
        const normalized = normalizeToolInputArgs((args ?? {}) as Record<string, unknown>)
        const title = normalized.title as string
        const content = normalized.content as string
        // Return a structured payload that the frontend MessageBubble will interpret
        return JSON.stringify({
          kind: 'plugin-ui',
          text: `### ${title}\n\n${content}`,
          actions: [
            { id: 'view-more', label: 'View Details', href: 'https://openclaw.ai' }
          ]
        })
      }
    }
  ]
}

// Auto-register
getPluginManager().registerBuiltin('sample_ui', SampleUIPlugin)

export function buildSampleUITools(bctx: any) {
  if (!bctx.hasPlugin('sample_ui')) return []
  return [
    tool(
      async (args) => SampleUIPlugin.tools![0].execute(args as any, bctx),
      {
        name: 'show_plugin_card',
        description: SampleUIPlugin.tools![0].description,
        schema: z.object({
          title: z.string(),
          content: z.string()
        })
      }
    )
  ]
}
