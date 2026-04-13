import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isOwnerProcessDead, parseOwnerPid } from '@/lib/server/daemon/lease-owner'

function probeThrowing(code: string) {
  return {
    kill: () => {
      const err = new Error('mock probe failure') as NodeJS.ErrnoException
      err.code = code
      throw err
    },
  }
}

const probeAlive = { kill: () => true as const }

describe('parseOwnerPid', () => {
  it('returns the pid for a well-formed owner string', () => {
    assert.equal(parseOwnerPid('pid:12345:abc'), 12345)
    assert.equal(parseOwnerPid('pid:1:xyz'), 1)
  })

  it('returns null for unrecognised owner strings', () => {
    assert.equal(parseOwnerPid(null), null)
    assert.equal(parseOwnerPid(undefined), null)
    assert.equal(parseOwnerPid(''), null)
    assert.equal(parseOwnerPid('another process'), null)
    assert.equal(parseOwnerPid('pid::abc'), null)
    assert.equal(parseOwnerPid('pid:abc:xyz'), null)
    assert.equal(parseOwnerPid('host:hostname:pid:1:abc'), null)
  })

  it('rejects zero and negative pids', () => {
    assert.equal(parseOwnerPid('pid:0:abc'), null)
    assert.equal(parseOwnerPid('pid:-1:abc'), null)
  })
})

describe('isOwnerProcessDead — bug #41 stale-lease recovery', () => {
  it('returns true when the probe reports ESRCH (no such process)', () => {
    assert.equal(isOwnerProcessDead('pid:99999:abc', probeThrowing('ESRCH')), true)
  })

  it('returns false when the probe reports EPERM (process owned by someone else)', () => {
    // EPERM means the process exists but signal delivery is blocked. Assume alive
    // and do not steal the lease — bias towards waiting for TTL.
    assert.equal(isOwnerProcessDead('pid:99999:abc', probeThrowing('EPERM')), false)
  })

  it('returns false when the probe succeeds (process is alive)', () => {
    assert.equal(isOwnerProcessDead('pid:99999:abc', probeAlive), false)
  })

  it('returns false for any unknown probe error code (do not guess)', () => {
    assert.equal(isOwnerProcessDead('pid:99999:abc', probeThrowing('EAGAIN')), false)
    assert.equal(isOwnerProcessDead('pid:99999:abc', probeThrowing('UNKNOWN')), false)
  })

  it('returns false for owner strings we cannot parse (different host, malformed, missing)', () => {
    assert.equal(isOwnerProcessDead(null, probeThrowing('ESRCH')), false)
    assert.equal(isOwnerProcessDead('another process', probeThrowing('ESRCH')), false)
    assert.equal(isOwnerProcessDead('host:remote:pid:1:abc', probeThrowing('ESRCH')), false)
  })

  it('refuses to declare its own pid dead even if probe lies', () => {
    // Defence in depth: the current process is obviously alive; if a
    // pathological probe returned ESRCH for its own pid, we must not
    // act on that.
    const owner = `pid:${process.pid}:self`
    assert.equal(isOwnerProcessDead(owner, probeThrowing('ESRCH')), false)
  })
})
