import path from 'path'
import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import type { Plugin, PluginHooks } from '@/types'
import { getPluginManager } from '../plugins'
import { runStructuredExtraction } from '../structured-extract'
import type { ToolBuildContext } from './context'
import { safePath } from './context'
import { normalizeToolInputArgs } from './normalize-tool-args'
import { errorMessage } from '@/lib/shared-utils'

function resolveSessionForExtraction(bctx: ToolBuildContext) {
  const session = bctx.resolveCurrentSession?.()
  if (!session) throw new Error('extract requires an active session context.')
  return session
}

async function executeExtractAction(args: Record<string, unknown>, bctx: ToolBuildContext) {
  const normalized = normalizeToolInputArgs(args)
  const action = String(normalized.action || 'extract_structured').trim().toLowerCase()

  try {
    if (action === 'status') {
      const session = resolveSessionForExtraction(bctx)
      return JSON.stringify({
        provider: session.provider || null,
        model: session.model || null,
        source: 'session',
        supports: ['extract_structured', 'summarize'],
      })
    }

    const session = resolveSessionForExtraction(bctx)
    const filePath = typeof normalized.filePath === 'string' && normalized.filePath.trim()
      ? (path.isAbsolute(normalized.filePath) ? path.resolve(normalized.filePath) : safePath(bctx.cwd, normalized.filePath, bctx.filesystemScope))
      : typeof normalized.path === 'string' && normalized.path.trim()
        ? (path.isAbsolute(normalized.path) ? path.resolve(normalized.path) : safePath(bctx.cwd, normalized.path, bctx.filesystemScope))
        : null
    const schema = action === 'summarize' ? undefined : normalized.schema
    const instruction = typeof normalized.instruction === 'string'
      ? normalized.instruction
      : action === 'summarize'
        ? (typeof normalized.prompt === 'string' ? normalized.prompt : 'Summarize the input and extract the main entities and key points.')
        : typeof normalized.prompt === 'string'
          ? normalized.prompt
          : 'Extract the requested structured data.'
    const result = await runStructuredExtraction({
      session,
      text: typeof normalized.text === 'string' ? normalized.text : typeof normalized.content === 'string' ? normalized.content : null,
      filePath,
      instruction,
      schema,
      preferOcr: normalized.preferOcr === true,
      maxChars: typeof normalized.maxChars === 'number' ? Math.max(5_000, normalized.maxChars) : undefined,
    })

    return JSON.stringify({
      object: result.object,
      validationErrors: result.validationErrors,
      provider: result.provider,
      model: result.model,
      source: {
        kind: result.source.kind,
        filePath: result.source.filePath || null,
        method: result.source.artifact?.method || null,
        fileName: result.source.artifact?.fileName || null,
      },
      raw: normalized.includeRaw === true ? result.raw : undefined,
    })
  } catch (err: unknown) {
    return `Error: ${errorMessage(err)}`
  }
}

const ExtractPlugin: Plugin = {
  name: 'Extract',
  enabledByDefault: false,
  description: 'Run schema-driven structured extraction over text or local files using the current session model.',
  hooks: {
    getCapabilityDescription: () =>
      'I can turn unstructured text or documents into validated JSON with `extract`, using the current session provider/model and a caller-supplied schema.',
  } as PluginHooks,
  tools: [
    {
      name: 'extract',
      description: 'Structured extraction tool. Actions: extract_structured, summarize, status.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['extract_structured', 'summarize', 'status'] },
          text: { type: 'string' },
          content: { type: 'string' },
          filePath: { type: 'string' },
          schema: {},
          instruction: { type: 'string' },
          prompt: { type: 'string' },
          maxChars: { type: 'number' },
          preferOcr: { type: 'boolean' },
          includeRaw: { type: 'boolean' },
        },
        required: ['action'],
      },
      execute: async (args, context) => {
        const syntheticBuildContext = {
          cwd: context.session.cwd || process.cwd(),
          ctx: { sessionId: context.session.id, agentId: context.session.agentId || null },
          hasPlugin: () => true,
          hasTool: () => true,
          cleanupFns: [],
          commandTimeoutMs: 0,
          claudeTimeoutMs: 0,
          cliProcessTimeoutMs: 0,
          persistDelegateResumeId: () => undefined,
          readStoredDelegateResumeId: () => null,
          resolveCurrentSession: () => context.session,
          activePlugins: context.session.plugins || [],
        } as ToolBuildContext
        return executeExtractAction(args, syntheticBuildContext)
      },
    },
  ],
}

getPluginManager().registerBuiltin('extract', ExtractPlugin)

export function buildExtractTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasPlugin('extract')) return []
  return [
    tool(
      async (args) => executeExtractAction(args, bctx),
      {
        name: 'extract',
        description: ExtractPlugin.tools![0].description,
        schema: z.object({}).passthrough(),
      },
    ),
  ]
}
