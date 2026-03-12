import path from 'path'
import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import type { Plugin, PluginHooks } from '@/types'
import { getPluginManager } from '../plugins'
import {
  loadTabularFile,
  normalizeInlineRows,
  writeStructuredTable,
  type StructuredTable,
} from '../document-utils'
import type { ToolBuildContext } from './context'
import { safePath } from './context'
import { normalizeToolInputArgs } from './normalize-tool-args'
import { dedup, errorMessage } from '@/lib/shared-utils'

interface TableCondition {
  column: string
  op: string
  value?: unknown
}

interface SortSpec {
  column: string
  direction: 'asc' | 'desc'
}

interface GroupMetric {
  op: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'values'
  column?: string
  as?: string
}

function parseJsonValue<T>(value: unknown): T | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    try {
      return JSON.parse(trimmed) as T
    } catch {
      return null
    }
  }
  return value as T
}

function resolveTablePath(cwd: string, value: unknown, scope?: 'workspace' | 'machine'): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('filePath is required.')
  return path.isAbsolute(value) ? path.resolve(value) : safePath(cwd, value, scope)
}

async function loadPrimaryTable(normalized: Record<string, unknown>, cwd: string, scope?: 'workspace' | 'machine'): Promise<StructuredTable> {
  if (normalized.rows !== undefined) {
    const parsed = parseJsonValue<unknown[]>(normalized.rows) ?? normalized.rows
    return normalizeInlineRows(parsed)
  }
  const filePath = normalized.filePath ?? normalized.path
  return loadTabularFile(resolveTablePath(cwd, filePath, scope), {
    sheetName: typeof normalized.sheetName === 'string' ? normalized.sheetName : undefined,
  })
}

async function loadJoinTable(
  normalized: Record<string, unknown>,
  cwd: string,
  side: 'left' | 'right',
  scope?: 'workspace' | 'machine',
): Promise<StructuredTable> {
  const rowsKey = side === 'left' ? 'leftRows' : 'rightRows'
  const fileKey = side === 'left' ? 'leftFilePath' : 'rightFilePath'
  const sheetKey = side === 'left' ? 'leftSheetName' : 'rightSheetName'
  const rowSource = normalized[rowsKey] !== undefined
    ? normalized[rowsKey]
    : side === 'left'
      ? normalized.rows
      : undefined
  if (rowSource !== undefined) {
    const parsed = parseJsonValue<unknown[]>(rowSource) ?? rowSource
    return normalizeInlineRows(parsed)
  }
  const fileSource = normalized[fileKey] !== undefined
    ? normalized[fileKey]
    : side === 'left'
      ? normalized.filePath ?? normalized.path
      : undefined
  return loadTabularFile(resolveTablePath(cwd, fileSource, scope), {
    sheetName: typeof normalized[sheetKey] === 'string'
      ? normalized[sheetKey] as string
      : side === 'left' && typeof normalized.sheetName === 'string'
        ? normalized.sheetName
        : undefined,
  })
}

function previewTable(table: StructuredTable, sample = 50) {
  return {
    name: table.name,
    headers: table.headers,
    rowCount: table.rowCount,
    rows: table.rows.slice(0, sample),
    truncated: table.rowCount > sample,
  }
}

function scalarToString(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function numericValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function compareValues(left: unknown, right: unknown): number {
  const leftNumber = numericValue(left)
  const rightNumber = numericValue(right)
  if (leftNumber !== null && rightNumber !== null) return leftNumber - rightNumber
  return scalarToString(left).localeCompare(scalarToString(right), undefined, { numeric: true, sensitivity: 'base' })
}

function normalizeConditions(normalized: Record<string, unknown>): TableCondition[] {
  const where = parseJsonValue<TableCondition[]>(normalized.where) ?? (Array.isArray(normalized.where) ? normalized.where as TableCondition[] : [])
  if (where.length > 0) {
    return where
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => ({
        column: typeof entry.column === 'string' ? entry.column : '',
        op: typeof entry.op === 'string' ? entry.op.toLowerCase() : 'eq',
        value: entry.value,
      }))
      .filter((entry) => entry.column)
  }

  if (normalized.filters && typeof normalized.filters === 'object' && !Array.isArray(normalized.filters)) {
    return Object.entries(normalized.filters as Record<string, unknown>).map(([column, value]) => ({
      column,
      op: 'eq',
      value,
    }))
  }

  if (typeof normalized.column === 'string' && normalized.column.trim()) {
    if (normalized.greaterThan !== undefined) return [{ column: normalized.column, op: 'gt', value: normalized.greaterThan }]
    if (normalized.greaterThanOrEqual !== undefined) return [{ column: normalized.column, op: 'gte', value: normalized.greaterThanOrEqual }]
    if (normalized.lessThan !== undefined) return [{ column: normalized.column, op: 'lt', value: normalized.lessThan }]
    if (normalized.lessThanOrEqual !== undefined) return [{ column: normalized.column, op: 'lte', value: normalized.lessThanOrEqual }]
    if (normalized.contains !== undefined) return [{ column: normalized.column, op: 'contains', value: normalized.contains }]
    if (normalized.equals !== undefined) return [{ column: normalized.column, op: 'eq', value: normalized.equals }]
  }

  return []
}

function rowMatchesConditions(row: Record<string, unknown>, conditions: TableCondition[]): boolean {
  return conditions.every((condition) => {
    const actual = row[condition.column]
    const actualText = scalarToString(actual).toLowerCase()
    const expectedText = scalarToString(condition.value).toLowerCase()

    switch (condition.op) {
      case 'eq':
        return compareValues(actual, condition.value) === 0
      case 'neq':
        return compareValues(actual, condition.value) !== 0
      case 'gt':
        return compareValues(actual, condition.value) > 0
      case 'gte':
        return compareValues(actual, condition.value) >= 0
      case 'lt':
        return compareValues(actual, condition.value) < 0
      case 'lte':
        return compareValues(actual, condition.value) <= 0
      case 'contains':
        return actualText.includes(expectedText)
      case 'regex':
        if (typeof condition.value !== 'string' || !condition.value.trim()) return false
        try {
          return new RegExp(condition.value, 'i').test(actualText)
        } catch {
          return false
        }
      case 'in': {
        const values = Array.isArray(condition.value) ? condition.value : [condition.value]
        return values.some((entry) => compareValues(actual, entry) === 0)
      }
      case 'exists':
        return actual !== null && actual !== undefined && scalarToString(actual).trim().length > 0
      case 'not_empty':
        return scalarToString(actual).trim().length > 0
      default:
        return compareValues(actual, condition.value) === 0
    }
  })
}

function normalizeSortSpecs(normalized: Record<string, unknown>): SortSpec[] {
  const sort = parseJsonValue<SortSpec[]>(normalized.sort) ?? (Array.isArray(normalized.sort) ? normalized.sort as SortSpec[] : [])
  if (sort.length > 0) {
    return sort
      .map((entry) => ({
        column: typeof entry.column === 'string' ? entry.column : '',
        direction: (entry.direction === 'desc' ? 'desc' : 'asc') as 'asc' | 'desc',
      }))
      .filter((entry) => entry.column)
  }
  if (typeof normalized.sortBy === 'string' && normalized.sortBy.trim()) {
    return [{
      column: normalized.sortBy,
      direction: (normalized.direction === 'desc' ? 'desc' : 'asc') as 'asc' | 'desc',
    }]
  }
  return []
}

function applySort(table: StructuredTable, specs: SortSpec[]): StructuredTable {
  if (specs.length === 0) return table
  const rows = [...table.rows].sort((left, right) => {
    for (const spec of specs) {
      const result = compareValues(left[spec.column], right[spec.column])
      if (result !== 0) return spec.direction === 'desc' ? -result : result
    }
    return 0
  })
  return { ...table, rows, rowCount: rows.length }
}

function normalizeGroupMetrics(normalized: Record<string, unknown>): GroupMetric[] {
  const metrics = parseJsonValue<GroupMetric[]>(normalized.metrics) ?? (Array.isArray(normalized.metrics) ? normalized.metrics as GroupMetric[] : [])
  if (metrics.length > 0) {
    return metrics.map((metric) => ({
      op: ['count', 'sum', 'avg', 'min', 'max', 'values'].includes(metric.op) ? metric.op : 'count',
      column: typeof metric.column === 'string' ? metric.column : undefined,
      as: typeof metric.as === 'string' ? metric.as : undefined,
    }))
  }
  return [{ op: 'count', as: 'count' }]
}

function groupTable(table: StructuredTable, by: string[], metrics: GroupMetric[]): StructuredTable {
  const groups = new Map<string, Record<string, unknown>[]>()
  for (const row of table.rows) {
    const key = JSON.stringify(by.map((column) => row[column] ?? null))
    const current = groups.get(key) || []
    current.push(row)
    groups.set(key, current)
  }

  const outRows = Array.from(groups.entries()).map(([key, rows]) => {
    const groupValues = JSON.parse(key) as unknown[]
    const next: Record<string, unknown> = {}
    by.forEach((column, index) => {
      next[column] = groupValues[index] ?? null
    })
    for (const metric of metrics) {
      const name = metric.as || (metric.column ? `${metric.op}_${metric.column}` : metric.op)
      const values = metric.column ? rows.map((row) => row[metric.column!]) : []
      const numeric = values.map((value) => numericValue(value)).filter((value): value is number => value !== null)
      switch (metric.op) {
        case 'count':
          next[name] = rows.length
          break
        case 'sum':
          next[name] = numeric.reduce((total, value) => total + value, 0)
          break
        case 'avg':
          next[name] = numeric.length ? numeric.reduce((total, value) => total + value, 0) / numeric.length : null
          break
        case 'min':
          next[name] = numeric.length ? Math.min(...numeric) : null
          break
        case 'max':
          next[name] = numeric.length ? Math.max(...numeric) : null
          break
        case 'values':
          next[name] = dedup(values.map((value) => scalarToString(value)).filter(Boolean))
          break
      }
    }
    return next
  })

  const headers = dedup([...by, ...metrics.map((metric) => metric.as || (metric.column ? `${metric.op}_${metric.column}` : metric.op))])
  return {
    name: `${table.name || 'table'}_grouped`,
    headers,
    rows: outRows,
    rowCount: outRows.length,
  }
}

function dedupeTable(table: StructuredTable, keys: string[], keep: 'first' | 'last'): StructuredTable {
  const seen = new Map<string, Record<string, unknown>>()
  for (const row of table.rows) {
    const key = JSON.stringify(keys.map((column) => row[column] ?? null))
    if (keep === 'last' || !seen.has(key)) seen.set(key, row)
  }
  const rows = Array.from(seen.values())
  return { ...table, rows, rowCount: rows.length }
}

function joinTables(
  left: StructuredTable,
  right: StructuredTable,
  keys: string[],
  joinType: 'inner' | 'left',
  rightPrefix = 'right_',
): StructuredTable {
  const rightGroups = new Map<string, Record<string, unknown>[]>()
  for (const row of right.rows) {
    const key = JSON.stringify(keys.map((column) => row[column] ?? null))
    const current = rightGroups.get(key) || []
    current.push(row)
    rightGroups.set(key, current)
  }

  const rightHeaders = right.headers.map((header) => (keys.includes(header) ? null : left.headers.includes(header) ? `${rightPrefix}${header}` : header)).filter((header): header is string => !!header)
  const rows: Array<Record<string, unknown>> = []

  for (const leftRow of left.rows) {
    const key = JSON.stringify(keys.map((column) => leftRow[column] ?? null))
    const matches = rightGroups.get(key) || []
    if (matches.length === 0) {
      if (joinType === 'left') rows.push({ ...leftRow })
      continue
    }
    for (const rightRow of matches) {
      const merged: Record<string, unknown> = { ...leftRow }
      for (const header of right.headers) {
        if (keys.includes(header)) continue
        const target = left.headers.includes(header) ? `${rightPrefix}${header}` : header
        merged[target] = rightRow[header]
      }
      rows.push(merged)
    }
  }

  return {
    name: `${left.name || 'left'}_joined_${right.name || 'right'}`,
    headers: dedup([...left.headers, ...rightHeaders]),
    rows,
    rowCount: rows.length,
  }
}

function pivotTable(
  table: StructuredTable,
  indexColumns: string[],
  columnField: string,
  valueField: string,
  aggregate: 'count' | 'sum' | 'first',
): StructuredTable {
  const columnValues = dedup(table.rows.map((row) => scalarToString(row[columnField])).filter(Boolean))
  const grouped = new Map<string, Record<string, unknown>[]>()
  for (const row of table.rows) {
    const key = JSON.stringify(indexColumns.map((column) => row[column] ?? null))
    const current = grouped.get(key) || []
    current.push(row)
    grouped.set(key, current)
  }

  const rows = Array.from(grouped.entries()).map(([key, groupRows]) => {
    const base: Record<string, unknown> = {}
    const indexValues = JSON.parse(key) as unknown[]
    indexColumns.forEach((column, index) => {
      base[column] = indexValues[index] ?? null
    })
    for (const columnValue of columnValues) {
      const matches = groupRows.filter((row) => scalarToString(row[columnField]) === columnValue)
      if (aggregate === 'count') {
        base[columnValue] = matches.length
      } else if (aggregate === 'sum') {
        base[columnValue] = matches
          .map((row) => numericValue(row[valueField]))
          .filter((value): value is number => value !== null)
          .reduce((total, value) => total + value, 0)
      } else {
        base[columnValue] = matches[0]?.[valueField] ?? null
      }
    }
    return base
  })

  return {
    name: `${table.name || 'table'}_pivot`,
    headers: [...indexColumns, ...columnValues],
    rows,
    rowCount: rows.length,
  }
}

async function maybePersistOutput(normalized: Record<string, unknown>, cwd: string, table: StructuredTable, scope?: 'workspace' | 'machine') {
  const outputPath = typeof normalized.outputPath === 'string'
    ? normalized.outputPath
    : typeof normalized.saveTo === 'string'
      ? normalized.saveTo
      : typeof normalized.outputFilePath === 'string'
        ? normalized.outputFilePath
      : null
  if (!outputPath) return null
  const resolved = path.isAbsolute(outputPath) ? path.resolve(outputPath) : safePath(cwd, outputPath, scope)
  return writeStructuredTable(resolved, table)
}

async function executeTableAction(args: Record<string, unknown>, bctx: { cwd: string; filesystemScope?: 'workspace' | 'machine' }) {
  const normalized = normalizeToolInputArgs(args)
  const action = String(normalized.action || 'read').trim().toLowerCase()

  try {
    if (action === 'status') {
      return JSON.stringify({
        supports: ['read', 'load_csv', 'load_xlsx', 'summarize', 'filter', 'sort', 'group', 'pivot', 'dedupe', 'join', 'write'],
      })
    }

    if (action === 'join') {
      const left = await loadJoinTable(normalized, bctx.cwd, 'left', bctx.filesystemScope)
      const right = await loadJoinTable(normalized, bctx.cwd, 'right', bctx.filesystemScope)
      const keys = Array.isArray(normalized.on)
        ? normalized.on.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        : typeof normalized.on === 'string'
          ? [normalized.on]
          : []
      if (keys.length === 0) return 'Error: on is required for join.'
      const joined = joinTables(
        left,
        right,
        keys,
        normalized.joinType === 'left' ? 'left' : 'inner',
        typeof normalized.rightPrefix === 'string' && normalized.rightPrefix.trim() ? normalized.rightPrefix : 'right_',
      )
      const persisted = await maybePersistOutput(normalized, bctx.cwd, joined, bctx.filesystemScope)
      return JSON.stringify({ action, ...previewTable(joined), output: persisted })
    }

    let table = await loadPrimaryTable(normalized, bctx.cwd, bctx.filesystemScope)

    if (action === 'read' || action === 'load_csv' || action === 'load_xlsx') {
      return JSON.stringify({ action: 'read', ...previewTable(table) })
    }

    if (action === 'summarize') {
      const nonEmptyCounts = Object.fromEntries(table.headers.map((header) => [
        header,
        table.rows.filter((row) => scalarToString(row[header]).trim().length > 0).length,
      ]))
      return JSON.stringify({
        name: table.name,
        headers: table.headers,
        rowCount: table.rowCount,
        nonEmptyCounts,
        sample: table.rows.slice(0, 10),
      })
    }

    if (action === 'filter') {
      const conditions = normalizeConditions(normalized)
      if (conditions.length === 0) return 'Error: where or filters is required for filter.'
      const rows = table.rows.filter((row) => rowMatchesConditions(row, conditions))
      table = { ...table, rows, rowCount: rows.length }
    } else if (action === 'sort') {
      table = applySort(table, normalizeSortSpecs(normalized))
    } else if (action === 'group') {
      const by = Array.isArray(normalized.by)
        ? normalized.by.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        : typeof normalized.by === 'string'
          ? [normalized.by]
          : []
      if (by.length === 0) return 'Error: by is required for group.'
      table = groupTable(table, by, normalizeGroupMetrics(normalized))
    } else if (action === 'pivot') {
      const indexColumns = Array.isArray(normalized.index)
        ? normalized.index.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        : typeof normalized.index === 'string'
          ? [normalized.index]
          : []
      const columnField = typeof normalized.columns === 'string' ? normalized.columns : typeof normalized.column === 'string' ? normalized.column : ''
      const valueField = typeof normalized.value === 'string' ? normalized.value : ''
      if (indexColumns.length === 0 || !columnField || !valueField) {
        return 'Error: index, columns, and value are required for pivot.'
      }
      const aggregate = normalized.aggregate === 'sum' || normalized.aggregate === 'count' ? normalized.aggregate : 'first'
      table = pivotTable(table, indexColumns, columnField, valueField, aggregate)
    } else if (action === 'dedupe') {
      const keys = Array.isArray(normalized.on)
        ? normalized.on.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        : typeof normalized.on === 'string'
          ? [normalized.on]
          : Array.isArray(normalized.columns)
            ? normalized.columns.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
          : table.headers
      table = dedupeTable(table, keys, normalized.keep === 'last' ? 'last' : 'first')
    } else if (action === 'write') {
      const persisted = await maybePersistOutput(normalized, bctx.cwd, table, bctx.filesystemScope)
      if (!persisted) return 'Error: outputPath or saveTo is required for write.'
      return JSON.stringify({ action: 'write', output: persisted, ...previewTable(table) })
    } else {
      return `Error: Unknown action "${action}".`
    }

    const persisted = await maybePersistOutput(normalized, bctx.cwd, table, bctx.filesystemScope)
    return JSON.stringify({ action, ...previewTable(table), output: persisted })
  } catch (err: unknown) {
    return `Error: ${errorMessage(err)}`
  }
}

const TablePlugin: Plugin = {
  name: 'Table',
  enabledByDefault: false,
  description: 'Load, transform, join, pivot, and export CSV/XLSX/JSON tables without dropping to shell scripts.',
  hooks: {
    getCapabilityDescription: () =>
      'I can load and transform tabular data with `table`, including filtering, sorting, grouping, pivoting, deduping, joining, summarizing, and exporting results.',
  } as PluginHooks,
  tools: [
    {
      name: 'table',
      description: 'Tabular data tool. Actions: read, load_csv, load_xlsx, summarize, filter, sort, group, pivot, dedupe, join, write, status.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['read', 'load_csv', 'load_xlsx', 'summarize', 'filter', 'sort', 'group', 'pivot', 'dedupe', 'join', 'write', 'status'],
          },
          filePath: { type: 'string' },
          rows: {},
          where: {},
          filters: {},
          sort: {},
          sortBy: { type: 'string' },
          direction: { type: 'string', enum: ['asc', 'desc'] },
          by: {},
          metrics: {},
          index: {},
          columns: { type: 'string' },
          value: { type: 'string' },
          aggregate: { type: 'string', enum: ['first', 'count', 'sum'] },
          on: {},
          keep: { type: 'string', enum: ['first', 'last'] },
          leftFilePath: { type: 'string' },
          rightFilePath: { type: 'string' },
          leftRows: {},
          rightRows: {},
          joinType: { type: 'string', enum: ['inner', 'left'] },
          rightPrefix: { type: 'string' },
          outputPath: { type: 'string' },
          outputFilePath: { type: 'string' },
          saveTo: { type: 'string' },
          greaterThan: {},
          greaterThanOrEqual: {},
          lessThan: {},
          lessThanOrEqual: {},
          equals: {},
          contains: {},
          sheetName: { type: 'string' },
          leftSheetName: { type: 'string' },
          rightSheetName: { type: 'string' },
        },
        required: ['action'],
      },
      execute: async (args, context) => executeTableAction(args, { cwd: context.session.cwd || process.cwd() }),
    },
  ],
}

getPluginManager().registerBuiltin('table', TablePlugin)

export function buildTableTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasPlugin('table')) return []
  return [
    tool(
      async (args) => executeTableAction(args, { cwd: bctx.cwd, filesystemScope: bctx.filesystemScope }),
      {
        name: 'table',
        description: TablePlugin.tools![0].description,
        schema: z.object({}).passthrough(),
      },
    ),
  ]
}
