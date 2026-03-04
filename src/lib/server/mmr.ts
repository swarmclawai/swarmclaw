import { cosineSimilarity } from './embeddings'
import type { MemoryEntry } from '@/types'

/**
 * Applies Maximal Marginal Relevance (MMR) to diversify search results.
 * It balances relevance to the query (salience/similarity) against novelty 
 * compared to already-selected documents.
 */
export function applyMMR(
  queryEmbedding: number[],
  candidates: Array<{ entry: MemoryEntry; salience: number; embedding?: number[] }>,
  limit: number,
  lambda: number = 0.5
): MemoryEntry[] {
  if (candidates.length === 0) return []
  
  // Normalize salience to [0, 1] range
  const maxSalience = Math.max(...candidates.map(c => c.salience))
  const minSalience = Math.min(...candidates.map(c => c.salience))
  const salienceRange = maxSalience - minSalience || 1

  const candidatesWithNormalizedSalience = candidates.map(c => ({
    ...c,
    normSalience: (c.salience - minSalience) / salienceRange
  }))

  const selected: typeof candidatesWithNormalizedSalience = []
  const remaining = [...candidatesWithNormalizedSalience]

  // Debug: uncomment for troubleshooting
  // console.log(`[mmr] Starting MMR for ${remaining.length} candidates, limit=${limit}, lambda=${lambda}`)

  while (selected.length < limit && remaining.length > 0) {
    let bestMmrScore = -Infinity
    let bestIndex = -1

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]
      
      let maxSimToSelected = 0
      if (selected.length > 0 && candidate.embedding) {
        for (const sel of selected) {
          if (sel.embedding) {
            const sim = cosineSimilarity(candidate.embedding, sel.embedding)
            if (sim > maxSimToSelected) maxSimToSelected = sim
          }
        }
      }

      // MMR Score = Lambda * Relevance - (1 - Lambda) * Diversity (max similarity to selected)
      const mmrScore = (lambda * candidate.normSalience) - ((1 - lambda) * maxSimToSelected)
      
      // DEBUG LOG
      // console.log(`  Candidate ${candidate.entry.id}: rel=${candidate.normSalience.toFixed(3)}, div_penalty=${maxSimToSelected.toFixed(3)}, mmr=${mmrScore.toFixed(3)}`)

      if (mmrScore > bestMmrScore) {
        bestMmrScore = mmrScore
        bestIndex = i
      }
    }

    if (bestIndex !== -1) {
      const picked = remaining[bestIndex]
      // console.log(`[mmr] Picked ${picked.entry.id} with score ${bestMmrScore.toFixed(3)}`)
      selected.push(picked)
      remaining.splice(bestIndex, 1)
    } else {
      break
    }
  }

  return selected.map(s => s.entry)
}
