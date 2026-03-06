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
})
