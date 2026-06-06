import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildOpenCodeCliNoOutputMessage, OPENCODE_CLI_STDIO } from './opencode-cli'

describe('opencode-cli provider', () => {
  it('closes child stdin so argv-prompt runs do not hang waiting for input', () => {
    assert.deepEqual(OPENCODE_CLI_STDIO, ['ignore', 'pipe', 'pipe'])
  })

  it('reports a successful JSON event stream that never emits text', () => {
    assert.equal(
      buildOpenCodeCliNoOutputMessage(0, null, '', 1),
      'OpenCode CLI exited with code 0 after 1 event but returned no text output.',
    )
  })
})
