import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { UPLOAD_DIR } from '../storage'
import { resolveConnectorMediaInput } from './connector'

describe('resolveConnectorMediaInput', () => {
  it('resolves /api/uploads urls passed via mediaPath back to disk', () => {
    const filename = `screenshot-test-${Date.now()}.png`
    const uploadPath = path.join(UPLOAD_DIR, filename)
    fs.mkdirSync(UPLOAD_DIR, { recursive: true })
    fs.writeFileSync(uploadPath, 'png')

    try {
      const resolved = resolveConnectorMediaInput({
        cwd: process.cwd(),
        mediaPath: `/api/uploads/${filename}`,
      })
      assert.equal(resolved.error, undefined)
      assert.equal(resolved.mediaPath, uploadPath)
    } finally {
      fs.rmSync(uploadPath, { force: true })
    }
  })

  it('treats remote urls passed via mediaPath as sendable urls instead of local files', () => {
    const resolved = resolveConnectorMediaInput({
      cwd: process.cwd(),
      mediaPath: 'https://example.com/report.pdf',
    })

    assert.equal(resolved.error, undefined)
    assert.equal(resolved.mediaPath, undefined)
    assert.equal(resolved.fileUrl, 'https://example.com/report.pdf')
  })
})
