import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import fs from 'fs'
import path from 'path'
import { DATA_DIR } from '../data-dir'
import type { ToolBuildContext } from './context'
import type { Plugin, PluginHooks } from '@/types'
import { getPluginManager } from '../plugins'
import { normalizeToolInputArgs } from './normalize-tool-args'
import { errorMessage } from '@/lib/shared-utils'

const PLUGINS_DIR = path.join(DATA_DIR, 'plugins')

/**
 * Core Plugin Creator Execution Logic
 */
interface PluginCreatorContext {
  agentId?: string | null
  sessionId?: string | null
}

async function executePluginCreatorAction(args: Record<string, unknown>, ctxOrBctx?: ToolBuildContext | PluginCreatorContext) {
  const normalized = normalizeToolInputArgs(args)
  // Normalize context from either ToolBuildContext or simple { agentId, sessionId }
  const pctx: PluginCreatorContext = ctxOrBctx && 'ctx' in ctxOrBctx
    ? { agentId: (ctxOrBctx as ToolBuildContext).ctx?.agentId, sessionId: (ctxOrBctx as ToolBuildContext).ctx?.sessionId }
    : (ctxOrBctx as PluginCreatorContext) || {}
  const action = normalized.action as string | undefined
  const filename = (normalized.filename ?? normalized.fileName) as string | undefined
  const code = (normalized.code ?? normalized.content) as string | undefined
  const packageJson = normalized.packageJson ?? normalized.package_json ?? normalized.manifest
  const packageManager = typeof normalized.packageManager === 'string' ? normalized.packageManager : undefined

  try {
    if (!fs.existsSync(PLUGINS_DIR)) {
      fs.mkdirSync(PLUGINS_DIR, { recursive: true })
    }

    if (action === 'scaffold') {
      if (!filename || !code) return 'Error: filename and code are required for scaffold.'
      if (!filename.endsWith('.js')) return 'Error: filename must end with .js'

      const manager = getPluginManager()
      await manager.savePluginSource(filename, code, {
        packageJson,
        packageManager,
        installDependencies: packageJson !== undefined,
      })
      const filePath = path.join(PLUGINS_DIR, filename)

      // Auto-enable the plugin for the agent that created it
      if (pctx.agentId && pctx.sessionId) {
        try {
          const { loadSessions, saveSessions } = await import('../storage')
          const sessions = loadSessions()
          const session = sessions[pctx.sessionId!]
          if (session) {
            const currentTools = session.plugins || []
            if (!currentTools.includes(filename)) {
              session.plugins = [...currentTools, filename]
              saveSessions(sessions)
            }
          }
        } catch { /* best effort */ }
      }

      return JSON.stringify({
        type: 'plugin_scaffold_result',
        filename,
        filePath,
        message: `Plugin "${filename}" was scaffolded and reloaded successfully.`,
      })
    }

    if (action === 'install_dependencies') {
      if (!filename) return 'Error: filename is required for install_dependencies.'

      const manager = getPluginManager()
      if (packageJson !== undefined) {
        const source = manager.readPluginSource(filename)
        await manager.savePluginSource(filename, source, {
          packageJson,
          packageManager,
          installDependencies: false,
        })
      }
      const result = await manager.installPluginDependencies(filename, {
        packageManager: packageManager as import('@/types').PluginPackageManager | undefined,
      })
      return JSON.stringify({
        type: 'plugin_install_result',
        filename,
        packageManager: result.packageManager || packageManager || 'npm',
        message: `Dependencies installed for "${filename}".`,
      })
    }

    if (action === 'get_spec') {
      return `
SwarmClaw Plugin Specification:
A plugin is a JavaScript module (.js or .mjs) that can be dual-compatible with both SwarmClaw and OpenClaw platforms.

\`\`\`js
module.exports = {
  // --- Metadata ---
  id: 'my-plugin',
  name: 'My Plugin',           // Required
  description: 'What it does',
  version: '1.0.0',
  openclaw: true,              // Mark as OpenClaw-compatible

  // --- SwarmClaw Format (hooks + tools) ---
  hooks: {
    beforeAgentStart: async ({ session, message }) => {},
    afterAgentComplete: async ({ session, response }) => {},
    beforeToolExec: async ({ toolName, input }) => input,
    afterToolExec: async ({ session, toolName, input, output }) => {},
    transformInboundMessage: async ({ session, text }) => { return text; },
    transformOutboundMessage: async ({ session, text }) => { return text; },
    afterChatTurn: async ({ session, message, response, source, internal }) => {},
  },

  tools: [
    {
      name: 'my_custom_tool',
      description: 'Does something useful',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'The input to process' }
        },
        required: ['input']
      },
      execute: async (args, ctx) => {
        return 'Result: ' + args.input;
      }
    }
  ],

  // --- Real OpenClaw Format (register API) ---
  register(api) {
    api.registerHook('agent:start', (ctx) => {
      // Hook events: agent:start, agent:complete, tool:call, tool:result, message:inbound, message:outbound
    });
    api.registerTool({
      name: 'my_custom_tool',
      description: 'Does something useful',
      parameters: { type: 'object', properties: { input: { type: 'string' } } },
      execute: (args) => 'Result: ' + args.input
    });
    api.log.info('Plugin activated');
  },
};
\`\`\`

Key rules:
- Export SwarmClaw hooks/tools. Add register(api) too if you want OpenClaw compatibility.
- SwarmClaw checks hooks/tools first; OpenClaw checks register()
- Tools must have name, description, parameters (JSON Schema), and execute function
- Hooks are optional — only include the ones you need
- If your plugin needs npm/pnpm/yarn/bun packages, include a packageJson object during scaffold or call install_dependencies later.
- Dependency installs are run by the plugin manager inside a per-plugin workspace using the selected package manager with scripts disabled.
- Plugin settings are declared through ui.settingsFields and stored per plugin ID
- Keep plugins focused: one clear purpose per plugin
`
    }

    if (action === 'read') {
      if (!filename) return 'Error: filename required.'
      return getPluginManager().readPluginSource(filename)
    }

    if (action === 'edit') {
      if (!filename || !code) return 'Error: filename and code are required for edit.'
      const manager = getPluginManager()
      try {
        manager.readPluginSource(filename)
      } catch {
        return `File not found: ${filename}. Use scaffold to create new plugins.`
      }
      await manager.savePluginSource(filename, code)
      return `Updated ${filename} and reloaded plugin manager.`
    }

    if (action === 'delete') {
      if (!filename) return 'Error: filename required.'
      const filePath = path.join(PLUGINS_DIR, filename)
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
        getPluginManager().reload()
        return `Deleted ${filename} and reloaded manager.`
      }
      return `File not found: ${filename}`
    }

    return `Unknown action "${action}". Valid actions: get_spec, scaffold, read, edit, delete, install_dependencies`
  } catch (err: unknown) {
    return `Error: ${errorMessage(err)}`
  }
}

/**
 * Register as a Built-in Plugin
 */
const PluginCreatorPlugin: Plugin = {
  name: 'Plugin Creator',
  description: 'Design focused SwarmClaw plugins for durable capabilities and recurring automations.',
  hooks: {
    getCapabilityDescription: () => 'I can scaffold focused plugins (`plugin_creator_tool`) when a capability should become durable instead of living in a one-off sandbox script.',
    getOperatingGuidance: () => [
      'For recurring or scheduled automations, prefer a focused plugin plus `manage_schedules` over repeated sandbox runs.',
      'Put API keys in plugin settings or SwarmClaw secrets instead of hardcoding them in plugin source.',
      'Call `get_spec` before scaffolding so the plugin follows the current contract.',
    ],
  } as PluginHooks,
  tools: [
    {
      name: 'plugin_creator_tool',
      description: 'Create, read, edit, delete, or get the spec for writing new SwarmClaw plugins. Always call get_spec first to learn the correct plugin format.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get_spec', 'scaffold', 'read', 'edit', 'delete', 'install_dependencies'], description: 'get_spec: learn format. scaffold: create. read: view code. edit: update existing. delete: remove. install_dependencies: write/read package.json and install runtime deps.' },
          filename: { type: 'string', description: 'Plugin filename, e.g. my-plugin.js. Required for scaffold and delete.' },
          code: { type: 'string', description: 'The raw JavaScript code for the plugin. Required for scaffold.' },
          packageJson: { type: 'object', description: 'Optional package.json object for dependency-aware plugins. Use with scaffold or install_dependencies.' },
          packageManager: { type: 'string', enum: ['npm', 'pnpm', 'yarn', 'bun'], description: 'Optional package manager to use for dependency installs.' }
        },
        required: ['action']
      },
      execute: async (args, ctx) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const session = (ctx as any)?.session
        return executePluginCreatorAction(
          args as Record<string, unknown>,
          { agentId: session?.agentId as string | undefined, sessionId: session?.id as string | undefined }
        )
      }
    }
  ]
}

getPluginManager().registerBuiltin('plugin_creator', PluginCreatorPlugin)

/**
 * Legacy Bridge
 */
export function buildPluginCreatorTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasPlugin('plugin_creator')) return []
  return [
    tool(
      async (args) => executePluginCreatorAction(args, bctx),
      {
        name: 'plugin_creator_tool',
        description: PluginCreatorPlugin.tools![0].description,
        schema: z.object({
          action: z.enum(['get_spec', 'scaffold', 'read', 'edit', 'delete', 'install_dependencies']),
          filename: z.string().optional(),
          code: z.string().optional(),
          packageJson: z.record(z.string(), z.any()).optional(),
          packageManager: z.enum(['npm', 'pnpm', 'yarn', 'bun']).optional()
        })
      }
    )
  ]
}
