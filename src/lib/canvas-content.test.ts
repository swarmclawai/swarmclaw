import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeCanvasDocument,
  normalizeCanvasContent,
  isCanvasDocument,
  summarizeCanvasContent,
} from './canvas-content'

describe('normalizeCanvasContent', () => {
  it('returns null for null/undefined', () => {
    assert.equal(normalizeCanvasContent(null), null)
    assert.equal(normalizeCanvasContent(undefined), null)
  })

  it('returns string content as-is', () => {
    assert.equal(normalizeCanvasContent('<p>hello</p>'), '<p>hello</p>')
  })

  it('returns null for empty string', () => {
    assert.equal(normalizeCanvasContent(''), null)
  })

  it('normalizes a valid structured document', () => {
    const doc = normalizeCanvasContent({
      title: 'Test',
      blocks: [{ type: 'markdown', markdown: '# Hello' }],
    })
    assert.ok(doc !== null && typeof doc === 'object')
    assert.equal((doc as { kind: string }).kind, 'structured')
  })

  it('returns null for object without valid blocks', () => {
    assert.equal(normalizeCanvasContent({ blocks: [] }), null)
    assert.equal(normalizeCanvasContent({}), null)
    assert.equal(normalizeCanvasContent({ blocks: [{ type: 'unknown' }] }), null)
  })
})

describe('normalizeCanvasDocument', () => {
  it('returns null for non-object input', () => {
    assert.equal(normalizeCanvasDocument('string'), null)
    assert.equal(normalizeCanvasDocument(42), null)
    assert.equal(normalizeCanvasDocument(null), null)
    assert.equal(normalizeCanvasDocument([]), null)
    assert.equal(normalizeCanvasDocument(true), null)
  })

  it('normalizes a markdown block', () => {
    const doc = normalizeCanvasDocument({
      blocks: [{ type: 'markdown', markdown: '# Hi' }],
    })
    assert.ok(doc)
    assert.equal(doc.blocks.length, 1)
    assert.equal(doc.blocks[0].type, 'markdown')
    assert.equal(doc.kind, 'structured')
    assert.equal(doc.theme, 'slate') // default theme
  })

  it('applies theme when valid', () => {
    const doc = normalizeCanvasDocument({
      blocks: [{ type: 'markdown', markdown: 'x' }],
      theme: 'emerald',
    })
    assert.ok(doc)
    assert.equal(doc.theme, 'emerald')
  })

  it('defaults to slate for invalid theme', () => {
    const doc = normalizeCanvasDocument({
      blocks: [{ type: 'markdown', markdown: 'x' }],
      theme: 'neon',
    })
    assert.ok(doc)
    assert.equal(doc.theme, 'slate')
  })

  it('truncates title and subtitle', () => {
    const doc = normalizeCanvasDocument({
      title: 'A'.repeat(300),
      subtitle: 'B'.repeat(500),
      blocks: [{ type: 'markdown', markdown: 'x' }],
    })
    assert.ok(doc)
    assert.equal(doc.title!.length, 180)
    assert.equal(doc.subtitle!.length, 320)
  })

  it('skips invalid blocks and keeps valid ones', () => {
    const doc = normalizeCanvasDocument({
      blocks: [
        { type: 'markdown', markdown: 'valid' },
        { type: 'unknown_type' },
        null,
        'just a string',
        { type: 'code', code: 'console.log(1)' },
      ],
    })
    assert.ok(doc)
    assert.equal(doc.blocks.length, 2)
    assert.equal(doc.blocks[0].type, 'markdown')
    assert.equal(doc.blocks[1].type, 'code')
  })

  it('enforces max 24 blocks', () => {
    const blocks = Array.from({ length: 30 }, () => ({
      type: 'markdown',
      markdown: 'x',
    }))
    const doc = normalizeCanvasDocument({ blocks })
    assert.ok(doc)
    assert.equal(doc.blocks.length, 24)
  })

  it('normalizes metrics block', () => {
    const doc = normalizeCanvasDocument({
      blocks: [{
        type: 'metrics',
        items: [
          { label: 'CPU', value: '90%', tone: 'warning' },
          { label: 'Mem', value: '4GB', detail: 'of 16GB', tone: 'positive' },
          { label: 'missing value' }, // should be skipped
          { value: 'missing label' }, // should be skipped
        ],
      }],
    })
    assert.ok(doc)
    assert.equal(doc.blocks.length, 1)
    const block = doc.blocks[0] as { type: string; items: Array<{ label: string; value: string; tone: string }> }
    assert.equal(block.items.length, 2)
    assert.equal(block.items[0].tone, 'warning')
    assert.equal(block.items[1].tone, 'positive')
  })

  it('enforces max 24 metric items', () => {
    const items = Array.from({ length: 30 }, (_, i) => ({
      label: `L${i}`, value: `V${i}`,
    }))
    const doc = normalizeCanvasDocument({
      blocks: [{ type: 'metrics', items }],
    })
    assert.ok(doc)
    const block = doc.blocks[0] as { items: unknown[] }
    assert.equal(block.items.length, 24)
  })

  it('normalizes cards block', () => {
    const doc = normalizeCanvasDocument({
      blocks: [{
        type: 'cards',
        items: [
          { title: 'Card 1', body: 'content', tone: 'negative' },
          { body: 'no title' }, // skipped
        ],
      }],
    })
    assert.ok(doc)
    const block = doc.blocks[0] as { items: Array<{ title: string; tone: string }> }
    assert.equal(block.items.length, 1)
    assert.equal(block.items[0].tone, 'negative')
  })

  it('normalizes table block', () => {
    const doc = normalizeCanvasDocument({
      blocks: [{
        type: 'table',
        table: {
          columns: ['Name', 'Age'],
          rows: [['Alice', 30], ['Bob', true]],
          caption: 'Users',
        },
      }],
    })
    assert.ok(doc)
    assert.equal(doc.blocks[0].type, 'table')
  })

  it('rejects table with no columns', () => {
    const doc = normalizeCanvasDocument({
      blocks: [{
        type: 'table',
        table: { columns: [], rows: [] },
      }],
    })
    assert.equal(doc, null) // no valid blocks
  })

  it('rejects table with no rows', () => {
    const doc = normalizeCanvasDocument({
      blocks: [{
        type: 'table',
        table: { columns: ['A'], rows: [] },
      }],
    })
    assert.equal(doc, null)
  })

  it('limits table to 20 columns and 100 rows', () => {
    const columns = Array.from({ length: 25 }, (_, i) => `Col${i}`)
    const rows = Array.from({ length: 110 }, () => columns.map((_, i) => `val${i}`))
    const doc = normalizeCanvasDocument({
      blocks: [{
        type: 'table',
        table: { columns, rows },
      }],
    })
    assert.ok(doc)
    const block = doc.blocks[0] as { table: { columns: string[]; rows: unknown[][] } }
    assert.equal(block.table.columns.length, 20)
    assert.equal(block.table.rows.length, 100)
  })

  it('normalizes actions block', () => {
    const doc = normalizeCanvasDocument({
      blocks: [{
        type: 'actions',
        items: [
          { label: 'Submit', intent: 'primary', href: 'https://x.com' },
          { label: 'Delete', intent: 'danger' },
          { intent: 'primary' }, // no label → skipped
        ],
      }],
    })
    assert.ok(doc)
    const block = doc.blocks[0] as { items: Array<{ label: string; intent: string }> }
    assert.equal(block.items.length, 2)
    assert.equal(block.items[0].intent, 'primary')
    assert.equal(block.items[1].intent, 'danger')
  })

  it('defaults action intent to secondary', () => {
    const doc = normalizeCanvasDocument({
      blocks: [{
        type: 'actions',
        items: [{ label: 'Go', intent: 'invalid' }],
      }],
    })
    assert.ok(doc)
    const block = doc.blocks[0] as { items: Array<{ intent: string }> }
    assert.equal(block.items[0].intent, 'secondary')
  })

  it('normalizes code block with language', () => {
    const doc = normalizeCanvasDocument({
      blocks: [{
        type: 'code',
        code: 'const x = 1;',
        language: 'typescript',
      }],
    })
    assert.ok(doc)
    const block = doc.blocks[0] as { type: string; code: string; language: string }
    assert.equal(block.code, 'const x = 1;')
    assert.equal(block.language, 'typescript')
  })

  it('rejects code block with empty code', () => {
    const doc = normalizeCanvasDocument({
      blocks: [{ type: 'code', code: '' }],
    })
    assert.equal(doc, null)
  })

  it('coerces number/boolean to string in asTrimmedString contexts', () => {
    const doc = normalizeCanvasDocument({
      blocks: [{
        type: 'metrics',
        items: [{ label: 42, value: true }],
      }],
    })
    assert.ok(doc)
    const block = doc.blocks[0] as { items: Array<{ label: string; value: string }> }
    assert.equal(block.items[0].label, '42')
    assert.equal(block.items[0].value, 'true')
  })

  it('truncates markdown content to 20000 chars', () => {
    const longMarkdown = 'x'.repeat(25000)
    const doc = normalizeCanvasDocument({
      blocks: [{ type: 'markdown', markdown: longMarkdown }],
    })
    assert.ok(doc)
    const block = doc.blocks[0] as { markdown: string }
    assert.equal(block.markdown.length, 20000)
  })

  it('uses provided updatedAt when valid', () => {
    const doc = normalizeCanvasDocument({
      blocks: [{ type: 'markdown', markdown: 'x' }],
      updatedAt: 1234567890,
    })
    assert.ok(doc)
    assert.equal(doc.updatedAt, 1234567890)
  })

  it('falls back to Date.now() for invalid updatedAt', () => {
    const before = Date.now()
    const doc = normalizeCanvasDocument({
      blocks: [{ type: 'markdown', markdown: 'x' }],
      updatedAt: 'not a number',
    })
    const after = Date.now()
    assert.ok(doc)
    assert.ok(doc.updatedAt >= before && doc.updatedAt <= after)
  })
})

describe('isCanvasDocument', () => {
  it('returns true for valid document object', () => {
    assert.equal(isCanvasDocument({
      blocks: [{ type: 'markdown', markdown: 'hi' }],
    }), true)
  })

  it('returns false for non-documents', () => {
    assert.equal(isCanvasDocument('string'), false)
    assert.equal(isCanvasDocument(null), false)
    assert.equal(isCanvasDocument({}), false)
    assert.equal(isCanvasDocument({ blocks: [] }), false)
  })
})

describe('summarizeCanvasContent', () => {
  it('summarizes null content', () => {
    const summary = summarizeCanvasContent(null)
    assert.equal(summary.kind, 'empty')
    assert.equal(summary.hasContent, false)
    assert.equal(summary.contentLength, 0)
  })

  it('summarizes string content', () => {
    const summary = summarizeCanvasContent('<p>hello</p>')
    assert.equal(summary.kind, 'html')
    assert.equal(summary.hasContent, true)
    assert.equal(summary.contentLength, 12)
    assert.equal(summary.preview, '<p>hello</p>')
  })

  it('truncates preview to 500 chars for long strings', () => {
    const long = 'x'.repeat(600)
    const summary = summarizeCanvasContent(long)
    assert.equal((summary.preview as string).length, 500)
  })

  it('summarizes structured document', () => {
    const doc = normalizeCanvasDocument({
      title: 'My Doc',
      blocks: [
        { type: 'markdown', markdown: '# Heading' },
        { type: 'code', code: 'x = 1' },
      ],
    })!
    const summary = summarizeCanvasContent(doc)
    assert.equal(summary.kind, 'structured')
    assert.equal(summary.hasContent, true)
    assert.equal(summary.blockCount, 2)
    assert.equal(summary.title, 'My Doc')
    assert.deepEqual(summary.blockTypes, ['markdown', 'code'])
  })
})
