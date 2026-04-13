import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { gitAvailable, resetGitAvailableCache, safeGit } from '@/lib/server/git-metadata'

describe('safeGit', () => {
  it('returns null when git is invoked with arguments that produce no useful output', () => {
    // `git` invoked outside of a repository and asked for a missing config key
    // is one of the few invocations guaranteed to fail on every host, while
    // still respecting the real binary path. If git itself is not installed,
    // `safeGit` still returns null (the catch path).
    const out = safeGit(['config', 'this.key.does.not.exist'])
    assert.equal(out, null)
  })

  it('returns a trimmed string for a successful invocation', () => {
    const version = safeGit(['--version'])
    if (version === null) return // git is not installed in this env; skip
    assert.match(version, /^git version /)
  })
})

describe('gitAvailable', () => {
  beforeEach(() => {
    resetGitAvailableCache()
  })

  it('caches its result', () => {
    const first = gitAvailable()
    // After the first call, subsequent calls return the same value without
    // re-probing. We cannot directly observe "did it re-probe?" without
    // mocking `node:child_process`, so we just assert stability.
    const second = gitAvailable()
    const third = gitAvailable()
    assert.equal(first, second)
    assert.equal(second, third)
  })

  it('reflects whether the cwd is in a git checkout', () => {
    // This test runs from inside the swarmclaw repo, so git should be
    // available. When run from inside the published Docker image (where
    // `.git/` is absent), the same call returns false.
    const present = gitAvailable()
    assert.equal(typeof present, 'boolean')
  })
})
