import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { collectCollapsedMedia } from './tool-events-section'

describe('collectCollapsedMedia', () => {
  const screenshotEvent = {
    id: 'tool-1',
    name: 'browser',
    input: '{"action":"screenshot"}',
    output: '![Screenshot](/api/uploads/screenshot-123.png)',
    status: 'done' as const,
  }

  it('collects explicit screenshot media when enabled', () => {
    const media = collectCollapsedMedia([screenshotEvent], { showCollapsedMedia: true })

    assert.deepEqual(media?.images, ['/api/uploads/screenshot-123.png'])
  })

  it('skips collapsed media previews when disabled', () => {
    const media = collectCollapsedMedia([screenshotEvent], { showCollapsedMedia: false })

    assert.equal(media, null)
  })
})
