import type { ScoringCriterion, EvalCriterionResult } from './types'
import type { MessageToolEvent } from '@/types'

export async function scoreCriteria(
  criteria: ScoringCriterion[],
  responseText: string,
  toolEvents: MessageToolEvent[],
  judgeOpts?: { provider: string; model: string; apiKey: string | null; apiEndpoint?: string | null },
): Promise<EvalCriterionResult[]> {
  const results: EvalCriterionResult[] = []

  for (const criterion of criteria) {
    switch (criterion.evaluator) {
      case 'contains': {
        const found = responseText.toLowerCase().includes(criterion.expected.toLowerCase())
        results.push({
          criterion: criterion.name,
          score: found ? criterion.weight : 0,
          maxScore: criterion.weight,
          evidence: found ? `Found "${criterion.expected}" in response` : `"${criterion.expected}" not found in response`,
        })
        break
      }

      case 'regex': {
        const regex = new RegExp(criterion.expected, 'i')
        const matched = regex.test(responseText)
        results.push({
          criterion: criterion.name,
          score: matched ? criterion.weight : 0,
          maxScore: criterion.weight,
          evidence: matched ? `Pattern /${criterion.expected}/i matched` : `Pattern /${criterion.expected}/i did not match`,
        })
        break
      }

      case 'tool_used': {
        const used = toolEvents.some(e => e.name === criterion.expected)
        results.push({
          criterion: criterion.name,
          score: used ? criterion.weight : 0,
          maxScore: criterion.weight,
          evidence: used ? `Tool "${criterion.expected}" was used` : `Tool "${criterion.expected}" was not used`,
        })
        break
      }

      case 'llm_judge': {
        if (!judgeOpts) {
          results.push({
            criterion: criterion.name,
            score: 0,
            maxScore: criterion.weight,
            evidence: 'No judge provider configured; skipped',
          })
          break
        }

        try {
          const { buildChatModel } = await import('../build-llm')
          const { HumanMessage } = await import('@langchain/core/messages')

          const llm = buildChatModel({
            provider: judgeOpts.provider,
            model: judgeOpts.model,
            apiKey: judgeOpts.apiKey,
            apiEndpoint: judgeOpts.apiEndpoint,
          })

          const judgePrompt = `Rate the following AI response on a scale of 0-10.\n\nCriterion: ${criterion.expected}\n\nResponse:\n${responseText}\n\nReply with ONLY a number 0-10.`
          const result = await llm.invoke([new HumanMessage(judgePrompt)])
          const scoreText = typeof result.content === 'string' ? result.content : ''
          const parsed = parseInt(scoreText.trim(), 10)
          const rawScore = Number.isFinite(parsed) ? Math.max(0, Math.min(10, parsed)) : 5

          results.push({
            criterion: criterion.name,
            score: (rawScore / 10) * criterion.weight,
            maxScore: criterion.weight,
            evidence: `LLM judge: ${rawScore}/10`,
          })
        } catch (err: unknown) {
          results.push({
            criterion: criterion.name,
            score: 0,
            maxScore: criterion.weight,
            evidence: `LLM judge error: ${err instanceof Error ? err.message : String(err)}`,
          })
        }
        break
      }
    }
  }

  return results
}
