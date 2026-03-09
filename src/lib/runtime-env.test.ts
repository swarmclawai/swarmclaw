import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isDevelopmentLikeRuntime, isProductionRuntime } from './runtime-env'

describe('runtime env helpers', () => {
  it('treats missing NODE_ENV as development-like', () => {
    const previousNodeEnv = process.env.NODE_ENV;
    delete (process.env as any).NODE_ENV

    assert.equal(isDevelopmentLikeRuntime(), true)
    assert.equal(isProductionRuntime(), false)

    if (previousNodeEnv === undefined) delete (process.env as any).NODE_ENV
    else (process.env as any).NODE_ENV = previousNodeEnv
  })

  it('detects explicit production mode', () => {
    const previousNodeEnv = process.env.NODE_ENV;
    (process.env as any).NODE_ENV = 'production'

    assert.equal(isDevelopmentLikeRuntime(), false)
    assert.equal(isProductionRuntime(), true)

    if (previousNodeEnv === undefined) delete (process.env as any).NODE_ENV
    else (process.env as any).NODE_ENV = previousNodeEnv
  })
})
