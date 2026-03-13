import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

let originalFetch: typeof globalThis.fetch
let originalEnv: string | undefined
let originalDownloadEnv: string | undefined

function mockFetch(impl: (input: RequestInfo | URL) => Promise<Response>) {
  globalThis.fetch = impl as unknown as typeof globalThis.fetch
}

beforeEach(() => {
  originalFetch = globalThis.fetch
  originalEnv = process.env.CLAWHUB_API_URL
  originalDownloadEnv = process.env.CLAWHUB_DOWNLOAD_API_URL
  delete process.env.CLAWHUB_API_URL
  delete process.env.CLAWHUB_DOWNLOAD_API_URL
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalEnv !== undefined) {
    process.env.CLAWHUB_API_URL = originalEnv
  } else {
    delete process.env.CLAWHUB_API_URL
  }
  if (originalDownloadEnv !== undefined) {
    process.env.CLAWHUB_DOWNLOAD_API_URL = originalDownloadEnv
  } else {
    delete process.env.CLAWHUB_DOWNLOAD_API_URL
  }
})

describe('searchClawHub', () => {
  // Module caches CLAWHUB_BASE_URL at import time, so we need dynamic import
  // after setting env. However the default is baked in at module load.
  // We'll test the default URL by importing once.

  it('constructs correct URL with query params and returns parsed JSON', async () => {
    const mockRaw = {
      items: [{
        slug: 's1',
        displayName: 'test-skill',
        stats: { installsAllTime: 42, stars: 7 },
        latestVersion: { version: '2.0.0', changelog: 'Better preview data' },
        metadata: { category: 'automation' },
        updatedAt: 1700000000000,
      }],
      total: 1,
    }
    let capturedUrl = ''

    mockFetch(async (input: RequestInfo | URL) => {
      capturedUrl = String(input)
      return new Response(JSON.stringify(mockRaw), { status: 200 })
    })

    const { searchClawHub } = await import('@/lib/server/skills/clawhub-client')
    const result = await searchClawHub('hello world', 2, 10)

    assert.ok(capturedUrl.includes('/skills?'), `expected skills query in URL: ${capturedUrl}`)
    assert.ok(capturedUrl.includes('q=hello'), `expected q param: ${capturedUrl}`)
    assert.ok(capturedUrl.includes('limit=10'), `expected limit=10: ${capturedUrl}`)
    assert.ok(capturedUrl.includes('page=2'), `expected page=2: ${capturedUrl}`)
    assert.equal(result.skills.length, 1)
    assert.equal(result.skills[0].id, 's1')
    assert.equal(result.skills[0].name, 'test-skill')
    assert.equal(result.skills[0].downloads, 42)
    assert.equal(result.skills[0].stars, 7)
    assert.equal(result.skills[0].version, '2.0.0')
    assert.equal(result.skills[0].changelog, 'Better preview data')
    assert.equal(result.skills[0].url, 'https://clawhub.ai/skills/s1')
    assert.deepEqual(result.skills[0].metadata, { category: 'automation' })
    assert.equal(result.skills[0].updatedAt, 1700000000000)
    assert.equal(result.total, 1)
    assert.equal(result.page, 2)
  })

  it('uses default page=1 and limit=20', async () => {
    let capturedUrl = ''

    mockFetch(async (input: RequestInfo | URL) => {
      capturedUrl = String(input)
      return new Response(JSON.stringify({ skills: [], total: 0, page: 1 }), { status: 200 })
    })

    const { searchClawHub } = await import('@/lib/server/skills/clawhub-client')
    await searchClawHub('test')

    // page=1 is omitted from the URL since the server defaults to page 1
    assert.ok(!capturedUrl.includes('page='), `page param should be omitted for default: ${capturedUrl}`)
    assert.ok(capturedUrl.includes('limit=20'), `expected limit=20: ${capturedUrl}`)
  })

  it('uses default base URL when CLAWHUB_API_URL is not set', async () => {
    let capturedUrl = ''

    mockFetch(async (input: RequestInfo | URL) => {
      capturedUrl = String(input)
      return new Response(JSON.stringify({ skills: [], total: 0, page: 1 }), { status: 200 })
    })

    const { searchClawHub } = await import('@/lib/server/skills/clawhub-client')
    await searchClawHub('q')

    assert.ok(capturedUrl.startsWith('https://clawhub.ai/api/v1/skills'), `expected clawhub.ai base URL: ${capturedUrl}`)
  })

  it('returns empty results on non-200 response', async () => {
    mockFetch(async () => {
      return new Response('Not Found', { status: 404 })
    })

    const { searchClawHub } = await import('@/lib/server/skills/clawhub-client')
    const result = await searchClawHub('fail', 3)

    assert.deepStrictEqual(result.skills, [])
    assert.equal(result.total, 0)
    assert.equal(result.page, 3)
    assert.ok(result.error)
  })

  it('returns empty results on fetch network error', async () => {
    mockFetch(async () => {
      throw new Error('network failure')
    })

    const { searchClawHub } = await import('@/lib/server/skills/clawhub-client')
    const result = await searchClawHub('err', 5)

    assert.deepStrictEqual(result.skills, [])
    assert.equal(result.total, 0)
    assert.equal(result.page, 5)
  })

  it('encodes special characters in query', async () => {
    let capturedUrl = ''

    mockFetch(async (input: RequestInfo | URL) => {
      capturedUrl = String(input)
      return new Response(JSON.stringify({ skills: [], total: 0, page: 1 }), { status: 200 })
    })

    const { searchClawHub } = await import('@/lib/server/skills/clawhub-client')
    await searchClawHub('a&b=c')

    assert.ok(capturedUrl.includes('q=a%26b%3Dc'))
  })

  it('uses cursor pagination when nextCursor is provided', async () => {
    let capturedUrl = ''

    mockFetch(async (input: RequestInfo | URL) => {
      capturedUrl = String(input)
      return new Response(JSON.stringify({ items: [], nextCursor: 'next-page' }), { status: 200 })
    })

    const { searchClawHub } = await import('@/lib/server/skills/clawhub-client')
    await searchClawHub('cursor test', 2, 20, 'abc123')

    assert.ok(capturedUrl.includes('cursor=abc123'), `expected cursor param: ${capturedUrl}`)
    assert.ok(!capturedUrl.includes('page=2'), `page param should be omitted when cursor is present: ${capturedUrl}`)
  })
})

describe('fetchSkillContent', () => {
  it('fetches raw URL and returns text content', async () => {
    const content = '# Skill README\nHello world'

    mockFetch(async (input: RequestInfo | URL) => {
      assert.equal(String(input), 'https://example.com/raw/skill.md')
      return new Response(content, { status: 200 })
    })

    const { fetchSkillContent } = await import('@/lib/server/skills/clawhub-client')
    const result = await fetchSkillContent('https://example.com/raw/skill.md')

    assert.equal(result, content)
  })

  it('downloads ClawHub zip archives and returns SKILL.md content', async () => {
    const JSZip = (await import('jszip')).default
    const archive = new JSZip()
    archive.file('SKILL.md', '# Palaia\n\nUse this skill for persistent memory.')
    archive.file('README.md', 'fallback readme')
    const zipBuffer = await archive.generateAsync({ type: 'nodebuffer' })
    const requestedUrls: string[] = []

    mockFetch(async (input: RequestInfo | URL) => {
      requestedUrls.push(String(input))
      return new Response(zipBuffer, {
        status: 200,
        headers: { 'content-type': 'application/zip' },
      })
    })

    const { fetchSkillContent } = await import('@/lib/server/skills/clawhub-client')
    const result = await fetchSkillContent('https://clawhub.ai/skills/palaia')

    assert.equal(result, '# Palaia\n\nUse this skill for persistent memory.')
    assert.equal(requestedUrls[0], 'https://wry-manatee-359.convex.site/api/v1/download?slug=palaia')
  })

  it('derives the slug from owner-aware ClawHub URLs before downloading the archive', async () => {
    const JSZip = (await import('jszip')).default
    const archive = new JSZip()
    archive.file('README.md', '# Owner Route Skill')
    const zipBuffer = await archive.generateAsync({ type: 'nodebuffer' })
    let requestedUrl = ''

    mockFetch(async (input: RequestInfo | URL) => {
      requestedUrl = String(input)
      return new Response(zipBuffer, {
        status: 200,
        headers: { 'content-type': 'application/zip' },
      })
    })

    const { fetchSkillContent } = await import('@/lib/server/skills/clawhub-client')
    const result = await fetchSkillContent('https://clawhub.ai/iret77/palaia')

    assert.equal(result, '# Owner Route Skill')
    assert.equal(requestedUrl, 'https://wry-manatee-359.convex.site/api/v1/download?slug=palaia')
  })

  it('throws on non-200 response', async () => {
    mockFetch(async () => {
      return new Response('Server Error', { status: 500 })
    })

    const { fetchSkillContent } = await import('@/lib/server/skills/clawhub-client')

    await assert.rejects(
      () => fetchSkillContent('https://example.com/raw/fail.md'),
      (err: Error) => {
        assert.ok(err.message.includes('500'))
        return true
      }
    )
  })

  it('throws on network error', async () => {
    mockFetch(async () => {
      throw new TypeError('fetch failed')
    })

    const { fetchSkillContent } = await import('@/lib/server/skills/clawhub-client')

    await assert.rejects(
      () => fetchSkillContent('https://down.example.com/skill.md'),
      (err: Error) => {
        assert.ok(err.message.includes('fetch failed'))
        return true
      }
    )
  })
})
