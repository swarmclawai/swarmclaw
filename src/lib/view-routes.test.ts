import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parsePath, buildPath, DEFAULT_VIEW, VIEW_TO_PATH, PATH_TO_VIEW } from './view-routes'

describe('DEFAULT_VIEW', () => {
  it('is home', () => {
    assert.equal(DEFAULT_VIEW, 'home')
  })
})

describe('VIEW_TO_PATH / PATH_TO_VIEW', () => {
  it('has matching forward and reverse mappings', () => {
    for (const [view, path] of Object.entries(VIEW_TO_PATH)) {
      assert.equal(PATH_TO_VIEW[path], view, `PATH_TO_VIEW['${path}'] should be '${view}'`)
    }
  })

  it('maps known views', () => {
    assert.equal(VIEW_TO_PATH.home, '/')
    assert.equal(VIEW_TO_PATH.agents, '/agents')
    assert.equal(VIEW_TO_PATH.settings, '/settings')
    assert.equal(VIEW_TO_PATH.mcp_servers, '/mcp-servers')
  })
})

describe('parsePath', () => {
  it('matches exact routes', () => {
    assert.deepEqual(parsePath('/'), { view: 'home', id: null })
    assert.deepEqual(parsePath('/agents'), { view: 'agents', id: null })
    assert.deepEqual(parsePath('/settings'), { view: 'settings', id: null })
    assert.deepEqual(parsePath('/mcp-servers'), { view: 'mcp_servers', id: null })
  })

  it('parses agents deep link with ID', () => {
    assert.deepEqual(parsePath('/agents/abc123'), { view: 'agents', id: 'abc123' })
  })

  it('parses chatrooms deep link with ID', () => {
    assert.deepEqual(parsePath('/chatrooms/room-1'), { view: 'chatrooms', id: 'room-1' })
  })

  it('decodes URI components in IDs', () => {
    assert.deepEqual(
      parsePath('/agents/hello%20world'),
      { view: 'agents', id: 'hello world' },
    )
  })

  it('returns null for malformed URI encoding', () => {
    assert.equal(parsePath('/agents/%ZZ'), null)
  })

  it('rejects deep link for views that do not support IDs', () => {
    assert.equal(parsePath('/settings/something'), null)
    assert.equal(parsePath('/wallets/abc'), null)
    assert.equal(parsePath('/tasks/123'), null)
  })

  it('rejects nested paths beyond one level', () => {
    assert.equal(parsePath('/agents/abc/def'), null)
  })

  it('returns null for unknown paths', () => {
    assert.equal(parsePath('/unknown'), null)
    assert.equal(parsePath('/foo/bar'), null)
  })

  it('longest-path-first matching prevents prefix collisions', () => {
    // /mcp-servers should not be matched as /m... prefix of something else
    assert.deepEqual(parsePath('/mcp-servers'), { view: 'mcp_servers', id: null })
  })
})

describe('buildPath', () => {
  it('builds basic view paths', () => {
    assert.equal(buildPath('home'), '/')
    assert.equal(buildPath('agents'), '/agents')
    assert.equal(buildPath('settings'), '/settings')
  })

  it('appends encoded ID for views that support it', () => {
    assert.equal(buildPath('agents', 'abc123'), '/agents/abc123')
    assert.equal(buildPath('chatrooms', 'room-1'), '/chatrooms/room-1')
  })

  it('encodes special characters in ID', () => {
    assert.equal(buildPath('agents', 'hello world'), '/agents/hello%20world')
    assert.equal(buildPath('agents', 'a/b'), '/agents/a%2Fb')
  })

  it('ignores ID for views that do not support it', () => {
    assert.equal(buildPath('settings', 'ignored'), '/settings')
    assert.equal(buildPath('wallets', 'ignored'), '/wallets')
  })

  it('ignores null/empty ID', () => {
    assert.equal(buildPath('agents', null), '/agents')
    assert.equal(buildPath('agents', ''), '/agents')
  })
})
