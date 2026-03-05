import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSendFilePaths } from './file'

describe('normalizeSendFilePaths', () => {
  it('reads top-level filePath', () => {
    const out = normalizeSendFilePaths({ filePath: 'foo.png' })
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
})
