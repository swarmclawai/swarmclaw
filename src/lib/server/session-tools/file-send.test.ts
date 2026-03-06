import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { findRecentSendFileFallbackPaths, normalizeSendFilePaths, resolveSendFileSourcePath } from './file'

describe('normalizeSendFilePaths', () => {
  it('reads top-level filePath', () => {
    const out = normalizeSendFilePaths({ filePath: 'foo.png' })
    assert.deepEqual(out, ['foo.png'])
  })

  it('reads top-level lowercase filepath alias', () => {
    const out = normalizeSendFilePaths({ filepath: 'foo.png' })
    assert.deepEqual(out, ['foo.png'])
  })

  it('reads nested input.files string array payload', () => {
    const out = normalizeSendFilePaths({
      input: {
        files: ['a.png', 'b.png'],
      },
    })
    assert.deepEqual(out, ['a.png', 'b.png'])
  })

  it('reads stringified input payload', () => {
    const out = normalizeSendFilePaths({
      input: JSON.stringify({
        files: ['a.png'],
      }),
    })
    assert.deepEqual(out, ['a.png'])
  })

  it('accepts filePaths arrays from natural model tool calls', () => {
    const out = normalizeSendFilePaths({
      filePaths: ['a.png', 'b.png'],
      input: JSON.stringify({
        filePaths: ['b.png', 'c.png'],
      }),
    })
    assert.deepEqual(out, ['a.png', 'b.png', 'c.png'])
  })

  it('reads files object entries with path/filePath and dedupes', () => {
    const out = normalizeSendFilePaths({
      files: [
        { path: 'a.png' },
        { filePath: 'b.png' },
        { path: 'a.png' },
      ],
    })
    assert.deepEqual(out, ['a.png', 'b.png'])
  })

  it('accepts filename/name aliases commonly produced by model tool calls', () => {
    const out = normalizeSendFilePaths({
      filename: 'brief.md',
      input: {
        files: [{ name: 'fallback.md' }],
      },
    })
    assert.deepEqual(out, ['brief.md', 'fallback.md'])
  })

  it('accepts fileId aliases commonly produced by model tool calls', () => {
    const out = normalizeSendFilePaths({
      input: {
        fileId: 'brief.md',
      },
    })
    assert.deepEqual(out, ['brief.md'])
  })

  it('extracts upload URLs from screenshot markdown tool output', () => {
    const out = normalizeSendFilePaths({
      filePath: '- [Screenshot of viewport](../../../.swarmclaw/browser-profiles/session/mcp-output/page.png)\n![Screenshot](/api/uploads/screenshot-123.png)',
    })
    assert.deepEqual(out, ['/api/uploads/screenshot-123.png', '../../../.swarmclaw/browser-profiles/session/mcp-output/page.png'])
  })

  it('falls back to a single recent file in the workspace when the payload is empty', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-file-'))
    const recent = path.join(dir, 'brief.md')
    const stale = path.join(dir, 'notes.txt')
    fs.writeFileSync(recent, '# brief')
    fs.writeFileSync(stale, 'old')
    const oldTime = new Date(Date.now() - 20 * 60 * 1000)
    fs.utimesSync(stale, oldTime, oldTime)

    const out = findRecentSendFileFallbackPaths(dir)
    assert.deepEqual(out, ['brief.md'])
  })

  it('resolves sandbox upload URLs when sending files', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'send-file-upload-'))
    const resolved = resolveSendFileSourcePath(cwd, 'sandbox:/api/uploads/artifact.md')
    assert.equal(path.basename(resolved), 'artifact.md')
    assert.match(resolved, /uploads[\/\\]artifact\.md$/)
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('resolves /workspace aliases against the current session workspace first', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'send-file-workspace-alias-'))
    const artifact = path.join(cwd, 'spec.md')
    fs.writeFileSync(artifact, '# spec')

    const resolved = resolveSendFileSourcePath(cwd, '/workspace/spec.md')

    assert.equal(resolved, artifact)
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('resolves browser profile screenshot paths back into the agent home directory', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'send-file-browser-profile-'))
    const resolved = resolveSendFileSourcePath(cwd, '../../../.swarmclaw/browser-profiles/example/mcp-output/page.png')
    assert.match(resolved, new RegExp(`\\.swarmclaw[\\\\/]browser-profiles[\\\\/]example[\\\\/]mcp-output[\\\\/]page\\.png$`))
    fs.rmSync(cwd, { recursive: true, force: true })
  })
})
