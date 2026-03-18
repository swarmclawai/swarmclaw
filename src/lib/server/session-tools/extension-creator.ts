import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import fs from 'fs'
import path from 'path'
import { DATA_DIR } from '../data-dir'
import type { ToolBuildContext } from './context'
import type { Extension, ExtensionHooks } from '@/types'
import { getExtensionManager } from '../extensions'
import { normalizeToolInputArgs } from './normalize-tool-args'
import { errorMessage } from '@/lib/shared-utils'
import { getEnabledExtensionIds } from '@/lib/capability-selection'

const EXTENSIONS_DIR = path.join(DATA_DIR, 'extensions')

/**
 * Core Extension Creator Execution Logic
 */
interface ExtensionCreatorContext {
  agentId?: string | null
  sessionId?: string | null
}

async function executeExtensionCreatorAction(args: Record<string, unknown>, ctxOrBctx?: ToolBuildContext | ExtensionCreatorContext) {
  const normalized = normalizeToolInputArgs(args)
  // Normalize context from either ToolBuildContext or simple { agentId, sessionId }
  const pctx: ExtensionCreatorContext = ctxOrBctx && 'ctx' in ctxOrBctx
    ? { agentId: (ctxOrBctx as ToolBuildContext).ctx?.agentId, sessionId: (ctxOrBctx as ToolBuildContext).ctx?.sessionId }
    : (ctxOrBctx as ExtensionCreatorContext) || {}
  const action = normalized.action as string | undefined
  const filename = (normalized.filename ?? normalized.fileName) as string | undefined
  const code = (normalized.code ?? normalized.content) as string | undefined
  const packageJson = normalized.packageJson ?? normalized.package_json ?? normalized.manifest
  const packageManager = typeof normalized.packageManager === 'string' ? normalized.packageManager : undefined

  try {
    if (!fs.existsSync(EXTENSIONS_DIR)) {
      fs.mkdirSync(EXTENSIONS_DIR, { recursive: true })
    }

    if (action === 'scaffold') {
      if (!filename || !code) return 'Error: filename and code are required for scaffold.'
      if (!filename.endsWith('.js')) return 'Error: filename must end with .js'

      const manager = getExtensionManager()
      await manager.saveExtensionSource(filename, code, {
        packageJson,
        packageManager,
        installDependencies: packageJson !== undefined,
      })
      const filePath = path.join(EXTENSIONS_DIR, filename)

      // Auto-enable the extension for the agent that created it
      if (pctx.agentId && pctx.sessionId) {
        try {
          const { loadSessions, saveSessions } = await import('../storage')
          const sessions = loadSessions()
          const session = sessions[pctx.sessionId!]
          if (session) {
            const currentExtensions = getEnabledExtensionIds(session)
            if (!currentExtensions.includes(filename)) {
              session.extensions = [...currentExtensions, filename]
              saveSessions(sessions)
            }
          }
        } catch { /* best effort */ }
      }

      return JSON.stringify({
        type: 'extension_scaffold_result',
        filename,
        filePath,
        message: `Extension "${filename}" was scaffolded and reloaded successfully.`,
      })
    }

    if (action === 'install_dependencies') {
      if (!filename) return 'Error: filename is required for install_dependencies.'

      const manager = getExtensionManager()
      if (packageJson !== undefined) {
        const source = manager.readExtensionSource(filename)
        await manager.saveExtensionSource(filename, source, {
          packageJson,
          packageManager,
          installDependencies: false,
        })
      }
      const result = await manager.installExtensionDependencies(filename, {
        packageManager: packageManager as import('@/types').ExtensionPackageManager | undefined,
      })
      return JSON.stringify({
        type: 'extension_install_result',
        filename,
        packageManager: result.packageManager || packageManager || 'npm',
        message: `Dependencies installed for "${filename}".`,
      })
    }

    if (action === 'get_spec') {
      return `
SwarmClaw Extension Specification:
An extension is a JavaScript module (.js or .mjs) that can be dual-compatible with both SwarmClaw and OpenClaw platforms.

\`\`\`js
module.exports = {
  // --- Metadata ---
  id: 'my-extension',
  name: 'My Extension',           // Required
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
    api.log.info('Extension activated');
  },
};
\`\`\`

Key rules:
- Export SwarmClaw hooks/tools. Add register(api) too if you want OpenClaw compatibility.
- SwarmClaw checks hooks/tools first; OpenClaw checks register()
- Tools must have name, description, parameters (JSON Schema), and execute function
- Hooks are optional â€” only include the ones you need
- If your extension needs npm/pnpm/yarn/bun packages, include a packageJson object during scaffold or call install_dependencies later.
- Dependency installs are run by the extension manager inside a per-extension workspace using the selected package manager with scripts disabled.
- Extension settings are declared through ui.settingsFields and stored per extension ID
- Keep extensions focused: one clear purpose per extension
`
    }

    if (action === 'read') {
      if (!filename) return 'Error: filename required.'
      return getExtensionManager().readExtensionSource(filename)
    }

    if (action === 'edit') {
      if (!filename || !code) return 'Error: filename and code are required for edit.'
      const manager = getExtensionManager()
      try {
        manager.readExtensionSource(filename)
      } catch {
        return `File not found: ${filename}. Use scaffold to create new extensions.`
      }
      await manager.saveExtensionSource(filename, code)
      return `Updated ${filename} and reloaded extension manager.`
    }

    if (action === 'delete') {
      if (!filename) return 'Error: filename required.'
      const filePath = path.join(EXTENSIONS_DIR, filename)
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
        getExtensionManager().reload()
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
 * Register as a Built-in Extension
 */
const ExtensionCreatorExtension: Extension = {
  name: 'Extension Creator',
  enabledByDefault: false,
  description: 'Design focused SwarmClaw extensions for durable capabilities and recurring automations.',
  hooks: {
    getCapabilityDescription: () => 'I can scaffold focused extensions (`extension_creator`) when a capability should become a durable extension instead of living in a one-off sandbox script.',
    getOperatingGuidance: () => [
      'For recurring or scheduled automations, prefer a focused extension plus `manage_schedules` over repeated sandbox runs.',
      'Put API keys in extension settings or SwarmClaw secrets instead of hardcoding them in extension source.',
      'Call `get_spec` before scaffolding so the extension follows the current contract.',
    ],
  } as ExtensionHooks,
  tools: [
    {
      name: 'extension_creator_tool',
      description: 'Create, read, edit, delete, or get the spec for writing new SwarmClaw extensions. Always call get_spec first to learn the correct format.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get_spec', 'scaffold', 'read', 'edit', 'delete', 'install_dependencies'], description: 'get_spec: learn format. scaffold: create. read: view code. edit: update existing. delete: remove. install_dependencies: write/read package.json and install runtime deps.' },
          filename: { type: 'string', description: 'Extension filename, e.g. my-extension.js. Required for scaffold and delete.' },
          code: { type: 'string', description: 'The raw JavaScript code for the extension. Required for scaffold.' },
          packageJson: { type: 'object', description: 'Optional package.json object for dependency-aware extensions. Use with scaffold or install_dependencies.' },
          packageManager: { type: 'string', enum: ['npm', 'pnpm', 'yarn', 'bun'], description: 'Optional package manager to use for dependency installs.' }
        },
        required: ['action']
      },
      execute: async (args, ctx) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const session = (ctx as any)?.session
        return executeExtensionCreatorAction(
          args as Record<string, unknown>,
          { agentId: session?.agentId as string | undefined, sessionId: session?.id as string | undefined }
        )
      }
    }
  ]
}

getExtensionManager().registerBuiltin('extension_creator', ExtensionCreatorExtension)

/**
 * Legacy Bridge
 */
export function buildExtensionCreatorTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasExtension('extension_creator')) return []
  return [
    tool(
      async (args) => executeExtensionCreatorAction(args as Record<string, unknown>, bctx),
      {
        name: 'extension_creator_tool',
        description: ExtensionCreatorExtension.tools![0].description,
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
