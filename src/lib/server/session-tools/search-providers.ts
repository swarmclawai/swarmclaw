import * as cheerio from 'cheerio'
import type { AppSettings } from '@/types'

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

export interface WebSearchProvider {
  id: string
  name: string
  search(query: string, maxResults: number): Promise<SearchResult[]>
}

interface RawSearchResult {
  title?: string
  url?: string
  content?: string
  description?: string
}

const UA = 'Mozilla/5.0 (compatible; SwarmClaw/1.0)'

// ---------------------------------------------------------------------------
// DuckDuckGo
// ---------------------------------------------------------------------------

function decodeDuckDuckGoUrl(rawUrl: string): string {
  if (!rawUrl) return rawUrl
  try {
    const url = rawUrl.startsWith('http')
      ? new URL(rawUrl)
      : new URL(rawUrl, 'https://duckduckgo.com')
    const uddg = url.searchParams.get('uddg')
    if (uddg) return decodeURIComponent(uddg)
    return url.toString()
  } catch {
    const fromQuery = rawUrl.match(/[?&]uddg=([^&]+)/)?.[1]
    if (fromQuery) {
      try { return decodeURIComponent(fromQuery) } catch { /* noop */ }
    }
    return rawUrl
  }
}

class DuckDuckGoProvider implements WebSearchProvider {
  id = 'duckduckgo'
  name = 'DuckDuckGo'

  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    const html = await res.text()
    const $ = cheerio.load(html)
    const results: SearchResult[] = []

    $('.result').each((_i, el) => {
      if (results.length >= maxResults) return false
      const link = $(el).find('a.result__a').first()
      const rawHref = link.attr('href') || ''
      const title = link.text().replace(/\s+/g, ' ').trim()
      if (!rawHref || !title) return
      const snippet = $(el).find('.result__snippet').first().text().replace(/\s+/g, ' ').trim()
      results.push({ title, url: decodeDuckDuckGoUrl(rawHref), snippet })
    })

    if (results.length === 0) {
      $('a.result__a').each((_i, el) => {
        if (results.length >= maxResults) return false
        const rawHref = $(el).attr('href') || ''
        const title = $(el).text().replace(/\s+/g, ' ').trim()
        if (!rawHref || !title) return
        results.push({ title, url: decodeDuckDuckGoUrl(rawHref), snippet: '' })
      })
    }

    return results
  }
}

// ---------------------------------------------------------------------------
// Google (scraping)
// ---------------------------------------------------------------------------

class GoogleProvider implements WebSearchProvider {
  id = 'google'
  name = 'Google'

  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${maxResults}`
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    const html = await res.text()
    const $ = cheerio.load(html)
    const results: SearchResult[] = []

    $('div.g').each((_i, el) => {
      if (results.length >= maxResults) return false
      const anchor = $(el).find('a').first()
      const href = anchor.attr('href') || ''
      if (!href || href.startsWith('/search')) return
      const title = $(el).find('h3').first().text().replace(/\s+/g, ' ').trim()
      if (!title) return
      // Snippet is in various containers depending on Google's layout
      const snippet = $(el).find('[data-sncf], .VwiC3b, .st').first().text().replace(/\s+/g, ' ').trim()
      results.push({ title, url: href, snippet })
    })

    return results
  }
}

// ---------------------------------------------------------------------------
// Bing (scraping)
// ---------------------------------------------------------------------------

class BingProvider implements WebSearchProvider {
  id = 'bing'
  name = 'Bing'

  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}`
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    const html = await res.text()
    const $ = cheerio.load(html)
    const results: SearchResult[] = []

    $('li.b_algo').each((_i, el) => {
      if (results.length >= maxResults) return false
      const anchor = $(el).find('h2 a').first()
      const href = anchor.attr('href') || ''
      const title = anchor.text().replace(/\s+/g, ' ').trim()
      if (!href || !title) return
      const snippet = $(el).find('.b_caption p').first().text().replace(/\s+/g, ' ').trim()
      results.push({ title, url: href, snippet })
    })

    return results
  }
}

// ---------------------------------------------------------------------------
// SearXNG (JSON API)
// ---------------------------------------------------------------------------

class SearXNGProvider implements WebSearchProvider {
  id = 'searxng'
  name = 'SearXNG'

  constructor(private baseUrl: string) {}

  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}/search?q=${encodeURIComponent(query)}&format=json`
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    const data = await res.json()
    const rawResults: RawSearchResult[] = Array.isArray(data.results) ? data.results : []
    return rawResults.slice(0, maxResults).map((r) => ({
      title: r.title || '',
      url: r.url || '',
      snippet: r.content || '',
    }))
  }
}

// ---------------------------------------------------------------------------
// Tavily (API key required — from secrets)
// ---------------------------------------------------------------------------

class TavilyProvider implements WebSearchProvider {
  id = 'tavily'
  name = 'Tavily'

  constructor(private apiKey: string) {}

  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: this.apiKey,
        query,
        max_results: maxResults,
      }),
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    const data = await res.json()
    const rawResults: RawSearchResult[] = Array.isArray(data.results) ? data.results : []
    return rawResults.slice(0, maxResults).map((r) => ({
      title: r.title || '',
      url: r.url || '',
      snippet: r.content || '',
    }))
  }
}

// ---------------------------------------------------------------------------
// Brave Search (API key required — from secrets)
// ---------------------------------------------------------------------------

class BraveProvider implements WebSearchProvider {
  id = 'brave'
  name = 'Brave Search'

  constructor(private apiKey: string) {}

  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`,
      {
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': this.apiKey,
        },
        signal: AbortSignal.timeout(15000),
      },
    )
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    const data = await res.json()
    const rawResults: RawSearchResult[] = Array.isArray(data.web?.results) ? data.web.results : []
    return rawResults.slice(0, maxResults).map((r) => ({
      title: r.title || '',
      url: r.url || '',
      snippet: r.description || '',
    }))
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function getSearchProvider(settings: Partial<AppSettings>): Promise<WebSearchProvider> {
  const providerId = settings.webSearchProvider || 'duckduckgo'

  switch (providerId) {
    case 'google':
      return new GoogleProvider()
    case 'bing':
      return new BingProvider()
    case 'searxng': {
      const url = settings.searxngUrl || 'http://localhost:8080'
      return new SearXNGProvider(url)
    }
    case 'tavily': {
      const { getSecret } = await import('../storage')
      const secret = await getSecret('tavily')
      if (!secret?.value) throw new Error('Tavily requires an API key. Add a secret named "tavily" in Secrets.')
      return new TavilyProvider(secret.value)
    }
    case 'brave': {
      const { getSecret } = await import('../storage')
      const secret = await getSecret('brave')
      if (!secret?.value) throw new Error('Brave Search requires an API key. Add a secret named "brave" in Secrets.')
      return new BraveProvider(secret.value)
    }
    default:
      return new DuckDuckGoProvider()
  }
}
