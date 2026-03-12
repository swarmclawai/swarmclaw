import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import fs from 'fs'
import type { ToolBuildContext } from './context'
import { safePath } from './context'
import type { Plugin, PluginHooks } from '@/types'
import { getPluginManager } from '../plugins'
import { normalizeToolInputArgs } from './normalize-tool-args'

/**
 * Core Edit File Execution Logic (Surgical Search and Replace)
 */
async function executeEditFile(args: { filePath: string; oldString: string; newString: string }, context: { cwd: string; filesystemScope?: 'workspace' | 'machine' }) {
  const normalized = normalizeToolInputArgs((args ?? {}) as Record<string, unknown>)
  const filePath = (normalized.filePath ?? normalized.path) as string
  const oldString = normalized.oldString as string
  const newString = normalized.newString as string
  try {
    const resolved = safePath(context.cwd, filePath, context.filesystemScope)
    if (!fs.existsSync(resolved)) return `Error: File not found: ${filePath}`
    
    const content = fs.readFileSync(resolved, 'utf-8')
    const count = content.split(oldString).length - 1
    
    if (count === 0) {
      return `Error: Exact match for 'oldString' not found in ${filePath}. Use 'files' with action='read' to check content.`
    }
    if (count > 1) {
      return `Error: Multiple matches (${count}) found for 'oldString'. Please provide more context to ensure a surgical replacement.`
    }

    const updated = content.replace(oldString, newString)
    fs.writeFileSync(resolved, updated, 'utf-8')
    return `Successfully updated ${filePath} (1 replacement made).`
  } catch (err: any) {
    return `Error: ${err.message}`
  }
}

/**
 * Register as a Built-in Plugin
 */
const EditFilePlugin: Plugin = {
  name: 'Core Edit File',
  description: 'Surgical search-and-replace within existing files.',
  hooks: {
    getCapabilityDescription: () => 'I can make precise edits to files (`edit_file`) — surgical find-and-replace without rewriting the whole file.',
  } as PluginHooks,
  tools: [
    {
      name: 'edit_file',
      description: 'Surgically replace a specific string within a file.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          oldString: { type: 'string', description: 'The exact literal text to replace' },
          newString: { type: 'string', description: 'The replacement text' }
        },
        required: ['filePath', 'oldString', 'newString']
      },
      execute: async (args, context) => executeEditFile(args as any, { cwd: context.session.cwd || process.cwd() })
    }
  ]
}

getPluginManager().registerBuiltin('edit_file', EditFilePlugin)

/**
 * Legacy Bridge
 */
export function buildEditFileTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasPlugin('edit_file')) return []
  return [
    tool(
      async (args) => executeEditFile(args as any, { cwd: bctx.cwd, filesystemScope: bctx.filesystemScope }),
      {
        name: 'edit_file',
        description: EditFilePlugin.tools![0].description,
        schema: z.object({}).passthrough()
      }
    )
  ]
}
