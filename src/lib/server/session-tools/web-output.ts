export function dedupeScreenshotMarkdownLines(parts: string[]): string[] {
  const imageLineRe = /^!\[[^\]]*]\(\/api\/uploads\/([^)]+)\)$/
  const imageLines = parts
    .map((line, index) => ({ line: line.trim(), index }))
    .map((entry) => {
      const match = entry.line.match(imageLineRe)
      return match ? { ...entry, filename: match[1] } : null
    })
    .filter((entry): entry is { line: string; index: number; filename: string } => !!entry)

  if (imageLines.length <= 1) return parts

  const preferred = imageLines.find((entry) => !entry.filename.startsWith('browser-')) || imageLines[0]
  const keepIndex = preferred.index
  return parts.filter((_, index) => !imageLines.some((entry) => entry.index === index) || index === keepIndex)
}
