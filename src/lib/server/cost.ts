// Model cost table: [inputCostPer1M, outputCostPer1M] in USD
const MODEL_COSTS: Record<string, [number, number]> = {
  // Anthropic
  'claude-opus-4-6': [15, 75],
  'claude-sonnet-4-6': [3, 15],
  'claude-haiku-4-5-20251001': [0.8, 4],
  'claude-sonnet-4-5-20250514': [3, 15],
  // OpenAI
  'gpt-4o': [2.5, 10],
  'gpt-4o-mini': [0.15, 0.6],
  'gpt-4.1': [2, 8],
  'gpt-4.1-mini': [0.4, 1.6],
  'gpt-4.1-nano': [0.1, 0.4],
  'o3': [10, 40],
  'o3-mini': [1.1, 4.4],
  'o4-mini': [1.1, 4.4],
  // OpenAI embeddings
  'text-embedding-3-small': [0.02, 0],
  'text-embedding-3-large': [0.13, 0],
}

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const costs = MODEL_COSTS[model]
  if (!costs) return 0
  const [inputRate, outputRate] = costs
  return (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000
}

export function getModelCosts(): Record<string, [number, number]> {
  return { ...MODEL_COSTS }
}
