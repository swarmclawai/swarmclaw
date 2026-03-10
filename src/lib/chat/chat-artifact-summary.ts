export type ChatArtifactKind = 'image' | 'pdf' | 'markdown' | 'file' | 'site'

export interface ChatArtifactItem {
  label: string
  href: string
  kind: ChatArtifactKind
  filename: string
}

export interface ChatArtifactSection {
  title: string
  items: ChatArtifactItem[]
}

export interface ChatArtifactSummary {
  title: string | null
  intro: string[]
  sections: ChatArtifactSection[]
  liveSitesTitle: string | null
  liveSites: ChatArtifactItem[]
  counts: {
    images: number
    pdfs: number
    markdown: number
    files: number
    sites: number
  }
}

const TITLE_RE = /^##+\s+(.+?)\s*$/
const SECTION_RE = /^###\s+(.+?)\s*$/
const LINK_BULLET_RE = /^-\s+\[([^\]]+)\]\(([^)]+)\)\s*$/
const BOLD_URL_BULLET_RE = /^-\s+\*\*([^*]+)\*\*:\s+(https?:\/\/\S+)\s*$/

function stripMarkdown(text: string): string {
  return text
    .replace(/[*_`#]/g, '')
    .replace(/\[(.*?)\]\([^)]+\)/g, '$1')
    .trim()
}

function inferArtifactKind(href: string): ChatArtifactKind {
  const normalized = href.trim().toLowerCase()
  if (/^https?:\/\/localhost:\d+/.test(normalized)) return 'site'
  if (/\.(png|jpe?g|gif|webp|svg|avif)(?:[?#]|$)/.test(normalized)) return 'image'
  if (/\.pdf(?:[?#]|$)/.test(normalized)) return 'pdf'
  if (/\.(md|markdown)(?:[?#]|$)/.test(normalized)) return 'markdown'
  return 'file'
}

function buildArtifactItem(label: string, href: string): ChatArtifactItem {
  const filename = href.split('/').pop()?.split('?')[0] || href
  return {
    label: stripMarkdown(label),
    href: href.trim(),
    kind: inferArtifactKind(href),
    filename,
  }
}

function pushSection(sections: ChatArtifactSection[], current: ChatArtifactSection | null) {
  if (!current || current.items.length === 0) return
  sections.push(current)
}

function countItems(sections: ChatArtifactSection[], liveSites: ChatArtifactItem[]) {
  const counts = {
    images: 0,
    pdfs: 0,
    markdown: 0,
    files: 0,
    sites: liveSites.length,
  }

  for (const item of sections.flatMap((section) => section.items)) {
    if (item.kind === 'image') counts.images += 1
    else if (item.kind === 'pdf') counts.pdfs += 1
    else if (item.kind === 'markdown') counts.markdown += 1
    else if (item.kind === 'site') counts.sites += 1
    else counts.files += 1
  }

  return counts
}

export function parseChatArtifactSummary(markdown: string): ChatArtifactSummary | null {
  const text = markdown.trim()
  if (!text) return null

  const lines = text.split(/\r?\n/)
  let title: string | null = null
  let currentSection: ChatArtifactSection | null = null
  const sections: ChatArtifactSection[] = []
  const intro: string[] = []
  const liveSites: ChatArtifactItem[] = []
  let liveSitesTitle: string | null = null
  let seenSection = false

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    const titleMatch = !seenSection ? line.match(TITLE_RE) : null
    if (titleMatch) {
      title = stripMarkdown(titleMatch[1])
      continue
    }

    const sectionMatch = line.match(SECTION_RE)
    if (sectionMatch) {
      pushSection(sections, currentSection)
      currentSection = { title: stripMarkdown(sectionMatch[1]), items: [] }
      seenSection = true
      continue
    }

    const linkMatch = line.match(LINK_BULLET_RE)
    if (linkMatch) {
      const item = buildArtifactItem(linkMatch[1], linkMatch[2])
      if (currentSection) currentSection.items.push(item)
      else if (item.kind === 'site') liveSites.push(item)
      else intro.push(stripMarkdown(line))
      continue
    }

    const liveSiteMatch = line.match(BOLD_URL_BULLET_RE)
    if (liveSiteMatch) {
      liveSites.push({
        label: stripMarkdown(liveSiteMatch[1]),
        href: liveSiteMatch[2],
        kind: 'site',
        filename: liveSiteMatch[2],
      })
      continue
    }

    if (!seenSection) {
      intro.push(stripMarkdown(line))
      continue
    }

    if (currentSection?.items.length === 0 && !liveSites.length) {
      liveSitesTitle = stripMarkdown(line)
      continue
    }

    if (!liveSites.length) {
      liveSitesTitle = stripMarkdown(line)
    }
  }

  pushSection(sections, currentSection)

  const totalSectionItems = sections.reduce((sum, section) => sum + section.items.length, 0)
  if (totalSectionItems < 3 || sections.length === 0) return null

  return {
    title,
    intro,
    sections,
    liveSitesTitle,
    liveSites,
    counts: countItems(sections, liveSites),
  }
}
