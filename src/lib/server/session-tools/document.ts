import path from 'path'
import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { genId } from '@/lib/id'
import type { DocumentEntry, Plugin, PluginHooks } from '@/types'
import { getPluginManager } from '../plugins'
import { loadDocuments, saveDocuments } from '../storage'
import { extractDocumentArtifact } from '../document-utils'
import type { ToolBuildContext } from './context'
import { findBinaryOnPath, safePath } from './context'
import { normalizeToolInputArgs } from './normalize-tool-args'
import { errorMessage } from '@/lib/shared-utils'

function parseMetadataInput(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      return {}
    }
  }
  return {}
}

function resolveFilePath(cwd: string, value: unknown, scope?: 'workspace' | 'machine'): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('filePath is required.')
  return path.isAbsolute(value) ? path.resolve(value) : safePath(cwd, value, scope)
}

function previewTables(tables: Awaited<ReturnType<typeof extractDocumentArtifact>>['tables']) {
  return tables.map((table) => ({
    name: table.name,
    headers: table.headers,
    rowCount: table.rowCount,
    rows: table.rows.slice(0, 20),
    truncated: table.rowCount > 20,
  }))
}

function searchStoredDocuments(documents: Record<string, DocumentEntry>, query: string, limit: number) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  return Object.values(documents)
    .map((doc) => {
      const hay = `${doc.title}\n${doc.fileName}\n${doc.content}`.toLowerCase()
      if (!terms.every((term) => hay.includes(term))) return null
      let score = hay.includes(query.toLowerCase()) ? 10 : 0
      for (const term of terms) {
        let at = hay.indexOf(term)
        while (at !== -1) {
          score += 1
          at = hay.indexOf(term, at + term.length)
        }
      }
      const firstTerm = terms[0] || query
      const at = hay.indexOf(firstTerm.toLowerCase())
      const start = at >= 0 ? Math.max(0, at - 120) : 0
      const end = Math.min(doc.content.length, start + 360)
      return {
        id: doc.id,
        title: doc.title,
        fileName: doc.fileName,
        score,
        snippet: doc.content.slice(start, end).replace(/\s+/g, ' ').trim(),
        updatedAt: doc.updatedAt,
      }
    })
    .filter((entry): entry is NonNullable<typeof entry> => !!entry)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

async function executeDocumentAction(
  args: Record<string, unknown>,
  bctx: { cwd: string; sessionId?: string | null; agentId?: string | null; filesystemScope?: 'workspace' | 'machine' },
) {
  const normalized = normalizeToolInputArgs(args)
  const action = String(normalized.action || 'status').trim().toLowerCase()

  try {
    if (action === 'status') {
      return JSON.stringify({
        pdftotext: findBinaryOnPath('pdftotext') || null,
        textutil: findBinaryOnPath('textutil') || null,
        tesseract: findBinaryOnPath('tesseract') || null,
        supports: ['read', 'metadata', 'ocr', 'extract_tables', 'store', 'list', 'search', 'get', 'delete'],
      })
    }

    if (action === 'list' || action === 'list_stored') {
      const documents = loadDocuments() as Record<string, DocumentEntry>
      const limit = typeof normalized.limit === 'number' ? Math.max(1, Math.min(normalized.limit, 200)) : 50
      return JSON.stringify(
        Object.values(documents)
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
          .slice(0, limit)
          .map((doc) => ({
            id: doc.id,
            title: doc.title,
            fileName: doc.fileName,
            sourcePath: doc.sourcePath,
            textLength: doc.textLength,
            method: doc.method,
            metadata: doc.metadata || {},
            createdAt: doc.createdAt,
            updatedAt: doc.updatedAt,
          })),
      )
    }

    if (action === 'search' || action === 'search_stored') {
      const query = typeof normalized.query === 'string' ? normalized.query.trim() : ''
      if (!query) return 'Error: query is required.'
      const documents = loadDocuments() as Record<string, DocumentEntry>
      const limit = typeof normalized.limit === 'number' ? Math.max(1, Math.min(normalized.limit, 50)) : 10
      const matches = searchStoredDocuments(documents, query, limit)
      return JSON.stringify({ query, total: matches.length, matches })
    }

    if (action === 'get' || action === 'get_stored') {
      const id = typeof normalized.id === 'string' ? normalized.id.trim() : ''
      if (!id) return 'Error: id is required.'
      const documents = loadDocuments() as Record<string, DocumentEntry>
      const doc = documents[id]
      if (!doc) return `Error: document "${id}" not found.`
      return JSON.stringify({
        ...doc,
        content: doc.content.length > 80_000 ? `${doc.content.slice(0, 80_000)}\n... [truncated]` : doc.content,
      })
    }

    if (action === 'delete' || action === 'delete_stored') {
      const id = typeof normalized.id === 'string' ? normalized.id.trim() : ''
      if (!id) return 'Error: id is required.'
      const documents = loadDocuments() as Record<string, DocumentEntry>
      if (!documents[id]) return `Error: document "${id}" not found.`
      delete documents[id]
      saveDocuments(documents)
      return JSON.stringify({ ok: true, id })
    }

    const filePath = resolveFilePath(bctx.cwd, normalized.filePath ?? normalized.path, bctx.filesystemScope)
    const artifact = await extractDocumentArtifact(filePath, {
      preferOcr: action === 'ocr' || normalized.preferOcr === true,
      maxChars: typeof normalized.maxChars === 'number' ? Math.max(5_000, normalized.maxChars) : undefined,
    })

    if (action === 'metadata') {
      return JSON.stringify({
        filePath: artifact.filePath,
        fileName: artifact.fileName,
        ext: artifact.ext,
        method: artifact.method,
        metadata: artifact.metadata,
        textLength: artifact.text.length,
        tableCount: artifact.tables.length,
      })
    }

    if (action === 'extract_tables') {
      return JSON.stringify({
        filePath: artifact.filePath,
        fileName: artifact.fileName,
        tableCount: artifact.tables.length,
        tables: previewTables(artifact.tables),
      })
    }

    if (action === 'store') {
      if (!artifact.text.trim()) return 'Error: extracted document text is empty.'
      const documents = loadDocuments() as Record<string, DocumentEntry>
      const now = Date.now()
      const docId = genId(8)
      const entry: DocumentEntry = {
        id: docId,
        title: typeof normalized.title === 'string' && normalized.title.trim() ? normalized.title.trim() : artifact.fileName,
        fileName: artifact.fileName,
        sourcePath: artifact.filePath,
        content: artifact.text,
        method: artifact.method,
        textLength: artifact.text.length,
        metadata: {
          ...artifact.metadata,
          ...parseMetadataInput(normalized.metadata),
          ext: artifact.ext,
          tableCount: artifact.tables.length,
          storedByAgentId: bctx.agentId || null,
          storedInSessionId: bctx.sessionId || null,
        },
        createdAt: now,
        updatedAt: now,
      }
      documents[entry.id] = entry
      saveDocuments(documents)
      return JSON.stringify({
        id: entry.id,
        title: entry.title,
        fileName: entry.fileName,
        textLength: entry.textLength,
        method: entry.method,
        metadata: entry.metadata,
      })
    }

    if (action === 'read' || action === 'ocr') {
      return JSON.stringify({
        filePath: artifact.filePath,
        fileName: artifact.fileName,
        ext: artifact.ext,
        method: artifact.method,
        text: artifact.text,
        textLength: artifact.text.length,
        metadata: artifact.metadata,
        tableCount: artifact.tables.length,
        tables: previewTables(artifact.tables),
      })
    }

    return `Error: Unknown action "${action}".`
  } catch (err: unknown) {
    return `Error: ${errorMessage(err)}`
  }
}

const DocumentPlugin: Plugin = {
  name: 'Document',
  enabledByDefault: false,
  description: 'Extract text/tables/OCR from local documents and optionally store them for later retrieval.',
  hooks: {
    getCapabilityDescription: () =>
      'I can parse local documents with `document`, including PDFs, office docs, OCR-able images, CSV/XLSX tables, and stored document search.',
  } as PluginHooks,
  tools: [
    {
      name: 'document',
      description: 'Document parsing tool. Actions: status, read, metadata, ocr, extract_tables, store, list, list_stored, search, search_stored, get, get_stored, delete, delete_stored.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'read', 'metadata', 'ocr', 'extract_tables', 'store', 'list', 'list_stored', 'search', 'search_stored', 'get', 'get_stored', 'delete', 'delete_stored'],
          },
          filePath: { type: 'string' },
          id: { type: 'string' },
          title: { type: 'string' },
          query: { type: 'string' },
          metadata: {},
          limit: { type: 'number' },
          maxChars: { type: 'number' },
          preferOcr: { type: 'boolean' },
        },
        required: ['action'],
      },
      execute: async (args, context) => executeDocumentAction(args, {
        cwd: context.session.cwd || process.cwd(),
        sessionId: context.session.id,
        agentId: context.session.agentId || null,
      }),
    },
  ],
}

getPluginManager().registerBuiltin('document', DocumentPlugin)

export function buildDocumentTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasPlugin('document')) return []
  return [
    tool(
      async (args) => executeDocumentAction(args, {
        cwd: bctx.cwd,
        sessionId: bctx.ctx?.sessionId || null,
        agentId: bctx.ctx?.agentId || null,
        filesystemScope: bctx.filesystemScope,
      }),
      {
        name: 'document',
        description: DocumentPlugin.tools![0].description,
        schema: z.object({}).passthrough(),
      },
    ),
  ]
}
