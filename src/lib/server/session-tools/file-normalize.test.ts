import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { executeFileAction, normalizeFileArgs } from './file'

describe('normalizeFileArgs', () => {
  it('infers write from top-level filename and text', () => {
    const out = normalizeFileArgs({ filename: 'note.txt', text: 'hello' })
    assert.equal(out.action, 'write')
    assert.equal(out.filePath, 'note.txt')
    assert.equal(out.content, 'hello')
  })

  it('accepts top-level name and body aliases', () => {
    const out = normalizeFileArgs({ name: 'note.txt', body: 'hello' })
    assert.equal(out.action, 'write')
    assert.equal(out.filePath, 'note.txt')
    assert.equal(out.content, 'hello')
  })

  it('infers read from filename when action is omitted', () => {
    const out = normalizeFileArgs({ filename: 'note.txt' })
    assert.equal(out.action, 'read')
    assert.equal(out.filePath, 'note.txt')
  })

  it('infers read from lowercase filepath alias when action is omitted', () => {
    const out = normalizeFileArgs({ filepath: 'note.txt' })
    assert.equal(out.action, 'read')
    assert.equal(out.filePath, 'note.txt')
  })

  it('infers list from directory aliases', () => {
    const out = normalizeFileArgs({ directory: 'docs' })
    assert.equal(out.action, 'list')
    assert.equal(out.dirPath, 'docs')
  })

  it('defaults empty file payloads to a workspace listing instead of an unknown action', () => {
    const out = normalizeFileArgs({})
    assert.equal(out.action, 'list')
  })

  it('infers write from bulk file entries with text content', () => {
    const out = normalizeFileArgs({
      files: [
        { filename: 'a.txt', text: 'alpha' },
      ],
    })
    assert.equal(out.action, 'write')
    assert.deepEqual(out.files, [{ filename: 'a.txt', text: 'alpha' }])
  })

  it('normalizes legacy write wrapper payloads', () => {
    const out = normalizeFileArgs({
      input: JSON.stringify({
        write: {
          filename: 'legacy.txt',
          content: 'legacy body',
        },
      }),
    })

    assert.equal(out.action, 'write')
    assert.equal(out.filePath, 'legacy.txt')
    assert.equal(out.content, 'legacy body')
  })

  it('preserves nested write.files arrays from natural model payloads', () => {
    const out = normalizeFileArgs({
      input: JSON.stringify({
        write: {
          files: [
            { name: 'report.md', content: '# report' },
          ],
        },
      }),
    })

    assert.equal(out.action, 'write')
    assert.deepEqual(out.files, [{ name: 'report.md', content: '# report' }])
  })

  it('parses stringified bulk file arrays from wrapped payloads', () => {
    const out = normalizeFileArgs({
      input: JSON.stringify({
        action: 'write',
        files: JSON.stringify([
          { path: 'offer-pack/offer-brief.md', content: '# brief' },
          { path: 'offer-pack/landing-copy.md', content: '# landing' },
        ]),
      }),
    })

    assert.equal(out.action, 'write')
    assert.deepEqual(out.files, [
      { path: 'offer-pack/offer-brief.md', content: '# brief' },
      { path: 'offer-pack/landing-copy.md', content: '# landing' },
    ])
  })

  it('treats trailing-slash write targets as directory creation', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'file-write-dir-'))
    const out = await executeFileAction({
      action: 'write',
      path: 'weather_update/',
      content: 'placeholder',
    }, { cwd })

    assert.equal(out, 'Created directory weather_update/')
    assert.equal(fs.statSync(path.join(cwd, 'weather_update')).isDirectory(), true)
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('does not inline binary screenshot data when reading image files', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'file-read-binary-'))
    const imagePath = path.join(cwd, 'screenshot-main.png')
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]))

    try {
      const out = await executeFileAction({
        action: 'read',
        filePath: 'screenshot-main.png',
      }, { cwd })

      assert.match(out, /Binary file: screenshot-main\.png/)
      assert.match(out, /Use send_file/)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })
})
