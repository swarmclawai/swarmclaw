import { z } from 'zod'

const suggestionsSchema = z.array(z.string().min(1).max(80)).length(3)

const SUGGESTIONS_RE = /<suggestions>\s*([\s\S]*?)\s*<\/suggestions>\s*$/

export function extractSuggestions(text: string): { clean: string; suggestions: string[] | null } {
  const match = text.match(SUGGESTIONS_RE)
  if (!match) return { clean: text, suggestions: null }

  const clean = text.slice(0, match.index).trimEnd()

  try {
    const parsed = JSON.parse(match[1])
    const validated = suggestionsSchema.parse(parsed)
    return { clean, suggestions: validated }
  } catch {
    return { clean, suggestions: null }
  }
}
