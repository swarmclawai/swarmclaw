import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'

describe('getSearchProvider — exa', () => {
  const originalEnv = process.env.EXA_API_KEY

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.EXA_API_KEY
    else process.env.EXA_API_KEY = originalEnv
  })

  it('throws when no API key is available', async () => {
    delete process.env.EXA_API_KEY
    const { getSearchProvider } = await import('./search-providers')
    await assert.rejects(
      () => getSearchProvider({ webSearchProvider: 'exa' }),
      (err: Error) => {
        assert.match(err.message, /Exa requires an API key/)
        return true
      },
    )
  })

  it('resolves an ExaProvider from EXA_API_KEY env var', async () => {
    process.env.EXA_API_KEY = 'test-key-123'
    const { getSearchProvider } = await import('./search-providers')
    const provider = await getSearchProvider({ webSearchProvider: 'exa' })
    assert.equal(provider.id, 'exa')
    assert.equal(provider.name, 'Exa')
  })

  it('prefers settings key over env var', async () => {
    process.env.EXA_API_KEY = 'env-key'
    const { getSearchProvider } = await import('./search-providers')
    const provider = await getSearchProvider({ webSearchProvider: 'exa', exaApiKey: 'settings-key' })
    assert.equal(provider.id, 'exa')
  })
})

describe('ExaProvider.search — response parsing', () => {
  const FIXTURE = {
    requestId: 'test-req-1',
    results: [
      {
        title: 'Exa AI Search',
        url: 'https://exa.ai',
        publishedDate: '2024-01-15',
        author: 'Exa Team',
        text: 'Exa is a search engine for AI.',
        highlights: ['Exa provides neural search.', 'Built for developers.'],
        highlightScores: [0.95, 0.88],
        summary: 'Exa is an AI-powered search engine built for developers.',
      },
      {
        title: 'Getting Started with Exa',
        url: 'https://docs.exa.ai/getting-started',
        text: 'Learn how to integrate Exa into your application.',
        highlights: [],
        summary: '',
      },
      {
        title: 'Minimal Result',
        url: 'https://example.com/minimal',
      },
    ],
  }

  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('parses a full API response into SearchResult[]', async () => {
    globalThis.fetch = mock.fn(async () => new Response(JSON.stringify(FIXTURE), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof globalThis.fetch

    process.env.EXA_API_KEY = 'test-key'
    const { getSearchProvider } = await import('./search-providers')
    const provider = await getSearchProvider({ webSearchProvider: 'exa' })
    const results = await provider.search('exa search', 10)

    assert.equal(results.length, 3)
    assert.equal(results[0].title, 'Exa AI Search')
    assert.equal(results[0].url, 'https://exa.ai')
    // Summary is preferred when available
    assert.equal(results[0].snippet, 'Exa is an AI-powered search engine built for developers.')
  })

  it('falls back to text when summary and highlights are empty', async () => {
    globalThis.fetch = mock.fn(async () => new Response(JSON.stringify(FIXTURE), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof globalThis.fetch

    process.env.EXA_API_KEY = 'test-key'
    const { getSearchProvider } = await import('./search-providers')
    const provider = await getSearchProvider({ webSearchProvider: 'exa' })
    const results = await provider.search('exa search', 10)

    // Second result has empty summary and empty highlights, should fall back to text
    assert.equal(results[1].snippet, 'Learn how to integrate Exa into your application.')
  })

  it('returns empty snippet when no content fields are present', async () => {
    globalThis.fetch = mock.fn(async () => new Response(JSON.stringify(FIXTURE), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof globalThis.fetch

    process.env.EXA_API_KEY = 'test-key'
    const { getSearchProvider } = await import('./search-providers')
    const provider = await getSearchProvider({ webSearchProvider: 'exa' })
    const results = await provider.search('exa search', 10)

    // Third result has no summary, no highlights, no text
    assert.equal(results[2].snippet, '')
    assert.equal(results[2].title, 'Minimal Result')
  })

  it('sends the integration tracking header', async () => {
    let capturedHeaders: Record<string, string> = {}
    globalThis.fetch = mock.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined
      if (headers) capturedHeaders = { ...headers }
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof globalThis.fetch

    process.env.EXA_API_KEY = 'test-key'
    const { getSearchProvider } = await import('./search-providers')
    const provider = await getSearchProvider({ webSearchProvider: 'exa' })
    await provider.search('test', 5)

    assert.equal(capturedHeaders['x-exa-integration'], 'swarmclaw')
    assert.equal(capturedHeaders['x-api-key'], 'test-key')
  })

  it('throws on non-OK HTTP response', async () => {
    globalThis.fetch = mock.fn(async () => new Response('Unauthorized', {
      status: 401,
      statusText: 'Unauthorized',
    })) as unknown as typeof globalThis.fetch

    process.env.EXA_API_KEY = 'bad-key'
    const { getSearchProvider } = await import('./search-providers')
    const provider = await getSearchProvider({ webSearchProvider: 'exa' })

    await assert.rejects(
      () => provider.search('test', 5),
      (err: Error) => {
        assert.match(err.message, /401/)
        return true
      },
    )
  })
})
