import * as cheerio from 'cheerio'
import { truncate } from './session-tools/context'

const BARE_LINK_RE = /https?:\/\/\S+/gi

/**
 * Automatically fetch and summarize links found in user messages.
 * This aligns SwarmClaw with OpenClaw's proactive link-understanding feature.
 */
export async function runLinkUnderstanding(message: string): Promise<string[]> {
  const links = message.match(BARE_LINK_RE)
  if (!links || links.length === 0) return []

  const uniqueLinks = Array.from(new Set(links)).slice(0, 3) // Limit to first 3 links
  const results: string[] = []

  for (const url of uniqueLinks) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SwarmClaw/1.0)' },
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) continue

      const contentType = res.headers.get('content-type') || ''
      if (contentType.includes('text/html')) {
        const html = await res.text()
        const $ = cheerio.load(html)
        
        // Handle YouTube specifically (OpenClaw favorite)
        if (url.includes('youtube.com/') || url.includes('youtu.be/')) {
          const title = $('meta[property="og:title"]').attr('content') || $('title').text()
          const desc = $('meta[property="og:description"]').attr('content') || ''
          results.push(`[Link Analysis: YouTube] ${url}\nTitle: ${title}\nDescription: ${desc}`)
          continue
        }

        // General web page extraction
        $('script, style, noscript, nav, footer, header').remove()
        const title = $('title').text().trim()
        const main = $('article, main, [role="main"]').first()
        const bodyText = (main.length ? main.text() : $('body').text())
          .replace(/\s+/g, ' ')
          .trim()
        
        results.push(`[Link Analysis] ${url}\nTitle: ${title}\nContent: ${truncate(bodyText, 1000)}`)
      }
    } catch (err) {
      // Fail silently for link understanding — don't block the main run
      console.error(`Link understanding failed for ${url}:`, err)
    }
  }

  return results
}
