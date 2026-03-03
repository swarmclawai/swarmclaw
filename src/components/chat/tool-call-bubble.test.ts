import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractMedia } from './tool-call-bubble'

describe('extractMedia', () => {
  it('dedupes browser-* screenshot variants when screenshot-* exists', () => {
    const output = [
      '![Screenshot](/api/uploads/browser-1772498741525.png)',
      '![Screenshot](/api/uploads/screenshot-1772498741526.png)',
      'Saved to: example_screenshot.png',
    ].join('\n')

    const media = extractMedia(output)
    assert.deepEqual(media.images, ['/api/uploads/screenshot-1772498741526.png'])
    assert.equal(media.cleanText, 'Saved to: example_screenshot.png')
  })

  it('keeps browser-* screenshot when it is the only image artifact', () => {
    const output = [
      '![Screenshot](/api/uploads/browser-1772498741525.png)',
      'Saved to: example_screenshot.png',
    ].join('\n')

    const media = extractMedia(output)
    assert.deepEqual(media.images, ['/api/uploads/browser-1772498741525.png'])
    assert.equal(media.cleanText, 'Saved to: example_screenshot.png')
  })
})
