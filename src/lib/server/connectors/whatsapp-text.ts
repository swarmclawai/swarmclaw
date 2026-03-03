import removeMarkdown from 'remove-markdown'

export function stripMarkdownForPlainChat(raw: string): string {
  const source = String(raw || '').replace(/\r\n?/g, '\n')
  if (!source) return ''

  let text = removeMarkdown(source, {
    gfm: true,
    useImgAltText: true,
    replaceLinksWithURL: true,
    separateLinksAndTexts: ': ',
  })

  // Collapse duplicate "url: url" patterns when link label already equals URL.
  text = text.replace(/(https?:\/\/[^\s]+): \1/g, '$1')
  text = text.replace(/\n{3,}/g, '\n\n')
  return text.trim()
}

/**
 * Convert markdown-heavy model output into WhatsApp-friendly plain text.
 * Uses a markdown parser package instead of ad-hoc regex-only stripping.
 */
export function formatTextForWhatsApp(raw: string): string {
  return stripMarkdownForPlainChat(raw)
}
