import { cosineSimilarity } from './embeddings'
import type { MemoryEntry } from '@/types'

/** Tokenize text into lowercase word tokens for Jaccard similarity */
function tokenizeForJaccard(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/\W+/).filter((t) => t.length > 1))
}

/** Jaccard similarity between two token sets (cheap text-based fallback) */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let intersection = 0
  for (const token of a) {
    if (b.has(token)) intersection++
  }
  return intersection / (a.size + b.size - intersection)
}

/** Get text content from a MemoryEntry for similarity comparison */
function memoryText(entry: MemoryEntry): string {
  return `${entry.title || ''} ${entry.content || ''}`
}

/**
 * Applies Maximal Marginal Relevance (MMR) to diversify search results.
 * It balances relevance to the query (salience/similarity) against novelty
 * compared to already-selected documents.
 *
 * Falls back to Jaccard text similarity when embeddings are unavailable,
 * ensuring MMR diversity even without vector search.
 */
export function applyMMR(
  queryEmbedding: number[] | null,
  candidates: Array<{ entry: MemoryEntry; salience: number; embedding?: number[] }>,
  limit: number,
  lambda: number = 0.7
): MemoryEntry[] {
  if (candidates.length === 0) return []

  // Normalize salience to [0, 1] range
  const maxSalience = Math.max(...candidates.map(c => c.salience))
  const minSalience = Math.min(...candidates.map(c => c.salience))
  const salienceRange = maxSalience - minSalience || 1

  // Pre-compute Jaccard token sets as fallback for candidates without embeddings
  const tokenSets = new Map<string, Set<string>>()
  const hasAnyEmbeddings = candidates.some((c) => c.embedding)
  if (!hasAnyEmbeddings) {
    for (const c of candidates) {
      tokenSets.set(c.entry.id, tokenizeForJaccard(memoryText(c.entry)))
    }
  }

  const candidatesWithNormalizedSalience = candidates.map(c => ({
    ...c,
    normSalience: (c.salience - minSalience) / salienceRange
  }))

  const selected: typeof candidatesWithNormalizedSalience = []
  const remaining = [...candidatesWithNormalizedSalience]

  while (selected.length < limit && remaining.length > 0) {
    let bestMmrScore = -Infinity
    let bestIndex = -1

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]

      let maxSimToSelected = 0
      if (selected.length > 0) {
        if (candidate.embedding && hasAnyEmbeddings) {
          // Embedding-based similarity
          for (const sel of selected) {
            if (sel.embedding) {
              const sim = cosineSimilarity(candidate.embedding, sel.embedding)
              if (sim > maxSimToSelected) maxSimToSelected = sim
            }
          }
        } else {
          // Jaccard text-based fallback
          const candTokens = tokenSets.get(candidate.entry.id) || tokenizeForJaccard(memoryText(candidate.entry))
          for (const sel of selected) {
            const selTokens = tokenSets.get(sel.entry.id) || tokenizeForJaccard(memoryText(sel.entry))
            const sim = jaccardSimilarity(candTokens, selTokens)
            if (sim > maxSimToSelected) maxSimToSelected = sim
          }
        }
      }

      const mmrScore = (lambda * candidate.normSalience) - ((1 - lambda) * maxSimToSelected)

      if (mmrScore > bestMmrScore) {
        bestMmrScore = mmrScore
        bestIndex = i
      }
    }

    if (bestIndex !== -1) {
      selected.push(remaining[bestIndex])
      remaining.splice(bestIndex, 1)
    } else {
      break
    }
  }

  return selected.map(s => s.entry)
}
