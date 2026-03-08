import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { NextRequest } from 'next/server'

import { proxy } from './proxy'

const originalAccessKey = process.env.ACCESS_KEY

afterEach(() => {
  if (originalAccessKey === undefined) delete process.env.ACCESS_KEY
  else process.env.ACCESS_KEY = originalAccessKey
})

describe('proxy', () => {
  it('keeps CORS headers on plugin-install auth failures for allowed origins', () => {
    process.env.ACCESS_KEY = 'top-secret'

    const request = new NextRequest('http://localhost/api/plugins/install', {
      method: 'POST',
      headers: {
        origin: 'https://swarmclaw.ai',
      },
    })

    const response = proxy(request)
    assert.equal(response.status, 401)
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://swarmclaw.ai')
    assert.equal(response.headers.get('vary'), 'Origin')
  })
})
