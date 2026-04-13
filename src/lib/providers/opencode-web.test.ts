import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseBasicAuth,
  buildAuthHeader,
  parseModelId,
  joinUrl,
  SseLineParser,
} from '@/lib/providers/opencode-web'

describe('opencode-web parseBasicAuth', () => {
  it('returns null for null / undefined / empty / whitespace', () => {
    assert.equal(parseBasicAuth(null), null)
    assert.equal(parseBasicAuth(undefined), null)
    assert.equal(parseBasicAuth(''), null)
    assert.equal(parseBasicAuth('   '), null)
  })

  it('treats a value with no colon as the password and defaults the username to "opencode"', () => {
    assert.deepEqual(parseBasicAuth('mypass'), { username: 'opencode', password: 'mypass' })
  })

  it('splits on the first colon and preserves later colons in the password', () => {
    assert.deepEqual(parseBasicAuth('bob:secret'), { username: 'bob', password: 'secret' })
    assert.deepEqual(parseBasicAuth('bob:s3cr:et'), { username: 'bob', password: 's3cr:et' })
  })

  it('handles empty halves', () => {
    assert.deepEqual(parseBasicAuth('bob:'), { username: 'bob', password: '' })
    assert.deepEqual(parseBasicAuth(':secret'), { username: '', password: 'secret' })
  })
})

describe('opencode-web buildAuthHeader', () => {
  it('returns undefined for null', () => {
    assert.equal(buildAuthHeader(null), undefined)
  })

  it('builds RFC-compliant Basic auth from username:password', () => {
    const header = buildAuthHeader({ username: 'opencode', password: 'mypass' })
    assert.equal(header, `Basic ${Buffer.from('opencode:mypass').toString('base64')}`)
  })

  it('round-trips with parseBasicAuth for a custom user', () => {
    const parsed = parseBasicAuth('bob:secret')
    assert.equal(buildAuthHeader(parsed), `Basic ${Buffer.from('bob:secret').toString('base64')}`)
  })
})

describe('opencode-web parseModelId', () => {
  it('splits providerID/modelID on the first slash', () => {
    assert.deepEqual(parseModelId('anthropic/claude-sonnet-4-5'), { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' })
    assert.deepEqual(parseModelId('openai/gpt-4.1'), { providerID: 'openai', modelID: 'gpt-4.1' })
  })

  it('preserves slashes inside the modelID', () => {
    assert.deepEqual(parseModelId('local/qwen/coder-14b'), { providerID: 'local', modelID: 'qwen/coder-14b' })
  })

  it('returns providerID-only when the user enters a bare string (server will reject with a real error)', () => {
    assert.deepEqual(parseModelId('claude-sonnet-4-5'), { providerID: 'claude-sonnet-4-5', modelID: '' })
  })

  it('handles empty / whitespace input', () => {
    assert.deepEqual(parseModelId(''), { providerID: '', modelID: '' })
    assert.deepEqual(parseModelId('   '), { providerID: '', modelID: '' })
    assert.deepEqual(parseModelId(undefined), { providerID: '', modelID: '' })
  })
})

describe('opencode-web joinUrl', () => {
  it('handles trailing and leading slashes idempotently', () => {
    assert.equal(joinUrl('http://localhost:4096', '/session'), 'http://localhost:4096/session')
    assert.equal(joinUrl('http://localhost:4096/', '/session'), 'http://localhost:4096/session')
    assert.equal(joinUrl('http://localhost:4096/', 'session'), 'http://localhost:4096/session')
    assert.equal(joinUrl('http://localhost:4096///', '///session'), 'http://localhost:4096///session')
  })
})

describe('opencode-web SseLineParser', () => {
  it('emits one event per data: line and ignores comments / event: / id:', () => {
    const events: unknown[] = []
    const parser = new SseLineParser()
    parser.feed(
      ':keepalive\nevent: message\ndata: {"type":"text-delta","text":"hi"}\nid: 1\n\n',
      (ev) => events.push(ev),
    )
    assert.deepEqual(events, [{ type: 'text-delta', text: 'hi' }])
  })

  it('buffers across chunk boundaries (split mid-line)', () => {
    const events: unknown[] = []
    const parser = new SseLineParser()
    parser.feed('data: {"type":"text-delta","text":"he', (ev) => events.push(ev))
    assert.equal(events.length, 0, 'incomplete line should not emit')
    parser.feed('llo"}\n', (ev) => events.push(ev))
    assert.deepEqual(events, [{ type: 'text-delta', text: 'hello' }])
  })

  it('tolerates CRLF line endings and skips blank data: lines', () => {
    const events: unknown[] = []
    const parser = new SseLineParser()
    parser.feed('data: {"type":"x","v":1}\r\ndata: \r\ndata: {"type":"y","v":2}\r\n', (ev) => events.push(ev))
    assert.deepEqual(events, [{ type: 'x', v: 1 }, { type: 'y', v: 2 }])
  })

  it('silently ignores malformed JSON payloads (heartbeats, partial frames)', () => {
    const events: unknown[] = []
    const parser = new SseLineParser()
    parser.feed('data: not json\ndata: {"type":"text-delta","text":"ok"}\n', (ev) => events.push(ev))
    assert.deepEqual(events, [{ type: 'text-delta', text: 'ok' }])
  })
})
