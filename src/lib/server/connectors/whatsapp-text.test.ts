import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatTextForWhatsApp } from './whatsapp-text'

describe('formatTextForWhatsApp', () => {
  it('converts markdown links to readable whatsapp text', () => {
    const input = 'See [Google](https://google.com) and [https://x.com](https://x.com)'
    const output = formatTextForWhatsApp(input)
    assert.equal(output, 'See Google: https://google.com and https://x.com')
  })

  it('converts common markdown emphasis syntax', () => {
    const input = '**Bold** __Italic__ ~~Strike~~'
    const output = formatTextForWhatsApp(input)
    assert.equal(output, 'Bold Italic Strike')
  })

  it('removes headings and preserves body text', () => {
    const input = '# Title\n\n## Subtitle\nBody line'
    const output = formatTextForWhatsApp(input)
    assert.equal(output, 'Title\n\nSubtitle\nBody line')
  })

  it('converts code fences to plain text content', () => {
    const input = '```ts\nconst x = 1\n```\n\nDone.'
    const output = formatTextForWhatsApp(input)
    assert.equal(output, 'const x = 1\n\nDone.')
  })
})
