export interface ScoringCriterion {
  name: string
  weight: number
  evaluator: 'contains' | 'regex' | 'tool_used' | 'llm_judge'
  expected: string
}

export interface EvalScenario {
  id: string
  name: string
  category: 'coding' | 'research' | 'companionship' | 'multi-step' | 'memory' | 'planning' | 'tool-usage' | 'long-lived'
  description: string
  userMessage: string
  expectedBehaviors: string[]
  scoringCriteria: ScoringCriterion[]
  timeoutMs: number
  tools: string[]
}

export interface EvalRun {
  id: string
  scenarioId: string
  agentId: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  startedAt: number
  endedAt?: number
  score: number
  maxScore: number
  details: EvalCriterionResult[]
  sessionId?: string
  error?: string
}

export interface EvalCriterionResult {
  criterion: string
  score: number
  maxScore: number
  evidence?: string
}

export interface EvalSuiteResult {
  agentId: string
  totalScore: number
  maxScore: number
  percentage: number
  runs: EvalRun[]
  completedAt: number
}
