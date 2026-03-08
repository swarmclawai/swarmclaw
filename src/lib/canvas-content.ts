import type {
  CanvasActionItem,
  CanvasBlock,
  CanvasCardItem,
  CanvasContent,
  CanvasDocument,
  CanvasMetricItem,
  CanvasTableData,
} from '@/types'

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asTrimmedString(value: unknown, max = 8000): string | null {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).slice(0, max)
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : null
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => asTrimmedString(entry, 240))
    .filter((entry): entry is string => Boolean(entry))
}

function normalizeMetricItems(value: unknown): CanvasMetricItem[] {
  if (!Array.isArray(value)) return []
  const items: CanvasMetricItem[] = []
  for (const entry of value) {
    const row = asObject(entry)
    if (!row) continue
    const label = asTrimmedString(row.label, 120)
    const metricValue = asTrimmedString(row.value, 120)
    if (!label || !metricValue) continue
    items.push({
      label,
      value: metricValue,
      detail: asTrimmedString(row.detail, 240) || undefined,
      tone: row.tone === 'positive' || row.tone === 'negative' || row.tone === 'warning' ? row.tone : 'default',
    })
    if (items.length >= 24) break
  }
  return items
}

function normalizeCardItems(value: unknown): CanvasCardItem[] {
  if (!Array.isArray(value)) return []
  const items: CanvasCardItem[] = []
  for (const entry of value) {
    const row = asObject(entry)
    if (!row) continue
    const title = asTrimmedString(row.title, 180)
    if (!title) continue
    items.push({
      title,
      body: asTrimmedString(row.body, 1600) || undefined,
      meta: asTrimmedString(row.meta, 200) || undefined,
      tone: row.tone === 'positive' || row.tone === 'negative' || row.tone === 'warning' ? row.tone : 'default',
    })
    if (items.length >= 24) break
  }
  return items
}

function normalizeActionItems(value: unknown): CanvasActionItem[] {
  if (!Array.isArray(value)) return []
  const items: CanvasActionItem[] = []
  for (const entry of value) {
    const row = asObject(entry)
    if (!row) continue
    const label = asTrimmedString(row.label, 120)
    if (!label) continue
    items.push({
      label,
      href: asTrimmedString(row.href, 1000) || undefined,
      note: asTrimmedString(row.note, 240) || undefined,
      intent: row.intent === 'primary' || row.intent === 'success' || row.intent === 'danger' ? row.intent : 'secondary',
    })
    if (items.length >= 24) break
  }
  return items
}

function normalizeTable(value: unknown): CanvasTableData | null {
  const row = asObject(value)
  if (!row) return null
  const columns = asStringArray(row.columns).slice(0, 20)
  if (!columns.length) return null
  const rows = Array.isArray(row.rows)
    ? row.rows
        .map((entry) => Array.isArray(entry)
          ? entry.slice(0, columns.length).map((cell) => (
            typeof cell === 'string'
            || typeof cell === 'number'
            || typeof cell === 'boolean'
            || cell === null
              ? cell
              : JSON.stringify(cell)
          ))
          : null)
        .filter((entry): entry is Array<string | number | boolean | null> => Array.isArray(entry))
        .slice(0, 100)
    : []
  return rows.length
    ? {
        columns,
        rows,
        caption: asTrimmedString(row.caption, 240) || undefined,
      }
    : null
}

function normalizeBlock(value: unknown): CanvasBlock | null {
  const row = asObject(value)
  if (!row) return null
  const title = asTrimmedString(row.title, 160) || undefined
  switch (row.type) {
    case 'markdown': {
      const markdown = asTrimmedString(row.markdown, 20_000)
      return markdown ? { type: 'markdown', title, markdown } : null
    }
    case 'metrics': {
      const items = normalizeMetricItems(row.items)
      return items.length ? { type: 'metrics', title, items } : null
    }
    case 'cards': {
      const items = normalizeCardItems(row.items)
      return items.length ? { type: 'cards', title, items } : null
    }
    case 'table': {
      const table = normalizeTable(row.table)
      return table ? { type: 'table', title, table } : null
    }
    case 'code': {
      const code = asTrimmedString(row.code, 20_000)
      return code ? { type: 'code', title, code, language: asTrimmedString(row.language, 60) || undefined } : null
    }
    case 'actions': {
      const items = normalizeActionItems(row.items)
      return items.length ? { type: 'actions', title, items } : null
    }
    default:
      return null
  }
}

export function normalizeCanvasDocument(value: unknown): CanvasDocument | null {
  const row = asObject(value)
  if (!row) return null
  const blocks = Array.isArray(row.blocks)
    ? row.blocks.map((entry) => normalizeBlock(entry)).filter((entry): entry is CanvasBlock => entry !== null).slice(0, 24)
    : []
  if (!blocks.length) return null
  return {
    kind: 'structured',
    title: asTrimmedString(row.title, 180) || undefined,
    subtitle: asTrimmedString(row.subtitle, 320) || undefined,
    theme: row.theme === 'sky' || row.theme === 'emerald' || row.theme === 'amber' || row.theme === 'rose' ? row.theme : 'slate',
    blocks,
    updatedAt: typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : Date.now(),
  }
}

export function isCanvasDocument(value: unknown): value is CanvasDocument {
  return normalizeCanvasDocument(value) !== null
}

export function normalizeCanvasContent(value: unknown): CanvasContent {
  if (typeof value === 'string') return value || null
  if (value === null || value === undefined) return null
  return normalizeCanvasDocument(value)
}

export function summarizeCanvasContent(content: CanvasContent): Record<string, unknown> {
  if (!content) {
    return { kind: 'empty', hasContent: false, contentLength: 0, preview: null }
  }
  if (typeof content === 'string') {
    return {
      kind: 'html',
      hasContent: true,
      contentLength: content.length,
      preview: content.slice(0, 500),
    }
  }
  return {
    kind: 'structured',
    hasContent: true,
    blockCount: content.blocks.length,
    title: content.title || null,
    blockTypes: content.blocks.map((block) => block.type),
    preview: JSON.stringify(content).slice(0, 500),
  }
}
