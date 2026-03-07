import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { inferWebActionFromArgs } from './web'

describe('inferWebActionFromArgs', () => {
  it('defaults to search when only query text is provided', () => {
    assert.equal(inferWebActionFromArgs({ query: 'latest US-Iran news' }), 'search')
  })

  it('defaults to fetch when the url is an absolute http url', () => {
    assert.equal(inferWebActionFromArgs({ url: 'https://example.com/article' }), 'fetch')
  })

  it('preserves an explicit action when present', () => {
    assert.equal(inferWebActionFromArgs({ action: 'search', url: 'https://example.com/article' }), 'search')
  })
})
