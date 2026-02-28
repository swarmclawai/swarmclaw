import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

let originalFetch: typeof globalThis.fetch
let originalEnv: string | undefined

beforeEach(() => {
  originalFetch = globalThis.fetch
  originalEnv = process.env.CLAWHUB_API_URL
  delete process.env.CLAWHUB_API_URL
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalEnv !== undefined) {
    process.env.CLAWHUB_API_URL = originalEnv
  } else {
    delete process.env.CLAWHUB_API_URL
  }
})

describe('searchClawHub', () => {
  // Module caches CLAWHUB_BASE_URL at import time, so we need dynamic import
  // after setting env. However the default is baked in at module load.
  // We'll test the default URL by importing once.

  it('constructs correct URL with query params and returns parsed JSON', async () => {
    const mockData = { skills: [{ id: 's1', name: 'test-skill' }], total: 1, page: 1 }
    let capturedUrl = ''

    globalThis.fetch = async (input: RequestInfo | URL) => {
      capturedUrl = String(input)
      return new Response(JSON.stringify(mockData), { status: 200 })
    }

    const { searchClawHub } = await import('./clawhub-client.ts')
    const result = await searchClawHub('hello world', 2, 10)

    assert.ok(capturedUrl.includes('/skills?q=hello%20world&page=2&limit=10'))
    assert.deepStrictEqual(result.skills, mockData.skills)
    assert.equal(result.total, 1)
    assert.equal(result.page, 1)
  })

  it('uses default page=1 and limit=20', async () => {
    let capturedUrl = ''

    globalThis.fetch = async (input: RequestInfo | URL) => {
      capturedUrl = String(input)
      return new Response(JSON.stringify({ skills: [], total: 0, page: 1 }), { status: 200 })
    }

    const { searchClawHub } = await import('./clawhub-client.ts')
    await searchClawHub('test')

    assert.ok(capturedUrl.includes('page=1'))
    assert.ok(capturedUrl.includes('limit=20'))
  })

  it('uses default base URL when CLAWHUB_API_URL is not set', async () => {
    let capturedUrl = ''

    globalThis.fetch = async (input: RequestInfo | URL) => {
      capturedUrl = String(input)
      return new Response(JSON.stringify({ skills: [], total: 0, page: 1 }), { status: 200 })
    }

    const { searchClawHub } = await import('./clawhub-client.ts')
    await searchClawHub('q')

    assert.ok(capturedUrl.startsWith('https://clawhub.openclaw.dev/api/skills'))
  })

  it('returns empty results on non-200 response', async () => {
    globalThis.fetch = async () => {
      return new Response('Not Found', { status: 404 })
    }

    const { searchClawHub } = await import('./clawhub-client.ts')
    const result = await searchClawHub('fail', 3)

    assert.deepStrictEqual(result.skills, [])
    assert.equal(result.total, 0)
    assert.equal(result.page, 3)
  })

  it('returns empty results on fetch network error', async () => {
    globalThis.fetch = async () => {
      throw new Error('network failure')
    }

    const { searchClawHub } = await import('./clawhub-client.ts')
    const result = await searchClawHub('err', 5)

    assert.deepStrictEqual(result.skills, [])
    assert.equal(result.total, 0)
    assert.equal(result.page, 5)
  })

  it('encodes special characters in query', async () => {
    let capturedUrl = ''

    globalThis.fetch = async (input: RequestInfo | URL) => {
      capturedUrl = String(input)
      return new Response(JSON.stringify({ skills: [], total: 0, page: 1 }), { status: 200 })
    }

    const { searchClawHub } = await import('./clawhub-client.ts')
    await searchClawHub('a&b=c')

    assert.ok(capturedUrl.includes('q=a%26b%3Dc'))
  })
})

describe('fetchSkillContent', () => {
  it('fetches raw URL and returns text content', async () => {
    const content = '# Skill README\nHello world'

    globalThis.fetch = async (input: RequestInfo | URL) => {
      assert.equal(String(input), 'https://example.com/raw/skill.md')
      return new Response(content, { status: 200 })
    }

    const { fetchSkillContent } = await import('./clawhub-client.ts')
    const result = await fetchSkillContent('https://example.com/raw/skill.md')

    assert.equal(result, content)
  })

  it('throws on non-200 response', async () => {
    globalThis.fetch = async () => {
      return new Response('Server Error', { status: 500 })
    }

    const { fetchSkillContent } = await import('./clawhub-client.ts')

    await assert.rejects(
      () => fetchSkillContent('https://example.com/raw/fail.md'),
      (err: Error) => {
        assert.ok(err.message.includes('500'))
        return true
      }
    )
  })

  it('throws on network error', async () => {
    globalThis.fetch = async () => {
      throw new TypeError('fetch failed')
    }

    const { fetchSkillContent } = await import('./clawhub-client.ts')

    await assert.rejects(
      () => fetchSkillContent('https://down.example.com/skill.md'),
      (err: Error) => {
        assert.ok(err.message.includes('fetch failed'))
        return true
      }
    )
  })
})
