import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dedupeScreenshotMarkdownLines } from './web-output'

describe('dedupeScreenshotMarkdownLines', () => {
  it('prefers screenshot-* image when both browser-* and screenshot-* variants are present', () => {
    const parts = [
      '![Screenshot](/api/uploads/browser-1772498741525.png)',
      '![Screenshot](/api/uploads/screenshot-1772498741526.png)',
      'Saved to: example_screenshot.png',
    ]

    const next = dedupeScreenshotMarkdownLines(parts)
    assert.deepEqual(next, [
      '![Screenshot](/api/uploads/screenshot-1772498741526.png)',
      'Saved to: example_screenshot.png',
    ])
  })

  it('keeps single image output untouched', () => {
    const parts = [
      '![Screenshot](/api/uploads/browser-1772498741525.png)',
      'Saved to: example_screenshot.png',
    ]

    const next = dedupeScreenshotMarkdownLines(parts)
    assert.deepEqual(next, parts)
  })
})
