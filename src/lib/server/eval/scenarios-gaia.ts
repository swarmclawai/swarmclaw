import type { EvalScenario } from './types'

/**
 * GAIA-Level-1-inspired scenarios: tool-grounded reasoning tasks that require
 * combining search, retrieval, and multi-step synthesis. Curated parallels
 * (not the upstream dataset) scaled to a single harness run.
 */
export const GAIA_L1_SCENARIOS: EvalScenario[] = [
  {
    id: 'gaia-capital-math',
    name: 'Capital-of-country arithmetic',
    category: 'multi-step',
    suite: 'gaia-l1',
    description: 'Identify the capital of a country, look up a population figure, and perform a simple calculation.',
    userMessage: 'What is the population of the capital of Australia, and roughly what percentage of the country\'s total population does it represent? Cite your sources.',
    expectedBehaviors: [
      'Uses web_search (or web_fetch) to find Canberra population and Australia total',
      'Performs the percentage calculation',
      'Cites sources',
    ],
    scoringCriteria: [
      { name: 'uses_search', weight: 2, evaluator: 'tool_used', expected: 'web_search' },
      { name: 'mentions_canberra', weight: 2, evaluator: 'contains', expected: 'Canberra' },
      { name: 'mentions_percent', weight: 1, evaluator: 'regex', expected: '\\d+(?:\\.\\d+)?\\s*%' },
      { name: 'mentions_source', weight: 1, evaluator: 'regex', expected: 'https?://|source|cite' },
      { name: 'correctness', weight: 4, evaluator: 'llm_judge', expected: 'Did the agent correctly identify Canberra as the capital of Australia, report a plausible population figure, compute a plausible share of the country\'s total (roughly 1.5-2%), and cite at least one source?' },
    ],
    timeoutMs: 180_000,
    tools: ['web_search', 'web_fetch'],
  },
  {
    id: 'gaia-multi-source-synthesis',
    name: 'Two-source synthesis',
    category: 'research',
    suite: 'gaia-l1',
    description: 'Pull facts from two different pages and combine them into a single conclusion.',
    userMessage: 'Find the release year of the first iPhone and the release year of the first Android phone (HTC Dream). How many months apart were they? Cite both sources.',
    expectedBehaviors: [
      'Searches for both release dates',
      'Identifies 2007 (iPhone) and 2008 (HTC Dream)',
      'Computes the month delta',
      'Cites both sources',
    ],
    scoringCriteria: [
      { name: 'uses_search', weight: 2, evaluator: 'tool_used', expected: 'web_search' },
      { name: 'mentions_2007', weight: 1, evaluator: 'contains', expected: '2007' },
      { name: 'mentions_2008', weight: 1, evaluator: 'contains', expected: '2008' },
      { name: 'mentions_months', weight: 1, evaluator: 'regex', expected: '\\d+\\s*(months?|mo)' },
      { name: 'correctness', weight: 5, evaluator: 'llm_judge', expected: 'Did the agent correctly identify iPhone (June 2007) and HTC Dream (October 2008), compute roughly 16 months apart, and cite two distinct sources?' },
    ],
    timeoutMs: 180_000,
    tools: ['web_search', 'web_fetch'],
  },
  {
    id: 'gaia-unit-conversion',
    name: 'Unit conversion with citation',
    category: 'tool-usage',
    suite: 'gaia-l1',
    description: 'Look up a measurement in one unit, convert to another, and show the arithmetic.',
    userMessage: 'What is the height of Mount Kilimanjaro in meters? Convert that to feet and show the arithmetic (1 m = 3.2808 ft). Cite your source.',
    expectedBehaviors: [
      'Searches for Kilimanjaro height',
      'Reports the canonical figure (5895 m)',
      'Multiplies by 3.2808 to get ~19341 ft',
      'Cites source',
    ],
    scoringCriteria: [
      { name: 'uses_search', weight: 2, evaluator: 'tool_used', expected: 'web_search' },
      { name: 'mentions_5895', weight: 1, evaluator: 'regex', expected: '5,?89[0-9]' },
      { name: 'mentions_feet', weight: 2, evaluator: 'regex', expected: '1[89],?\\d{3}\\s*(ft|feet)' },
      { name: 'shows_arithmetic', weight: 1, evaluator: 'regex', expected: '×|\\*|x\\s*3\\.2808' },
      { name: 'correctness', weight: 4, evaluator: 'llm_judge', expected: 'Did the agent report ~5895 m, convert to roughly 19341 ft showing the multiplication, and cite a source?' },
    ],
    timeoutMs: 180_000,
    tools: ['web_search', 'web_fetch'],
  },
  {
    id: 'gaia-chain-lookup',
    name: 'Chained fact lookup',
    category: 'research',
    suite: 'gaia-l1',
    description: 'Use the answer to one question to set up the next lookup.',
    userMessage: 'Find out who wrote the novel "Dune" (1965). Then find the year that author was born. Compute how old they were when Dune was published. Cite sources.',
    expectedBehaviors: [
      'Identifies Frank Herbert as the author',
      'Identifies 1920 as his birth year',
      'Computes 45',
      'Cites sources',
    ],
    scoringCriteria: [
      { name: 'uses_search', weight: 2, evaluator: 'tool_used', expected: 'web_search' },
      { name: 'mentions_herbert', weight: 2, evaluator: 'contains', expected: 'Frank Herbert' },
      { name: 'mentions_1920', weight: 1, evaluator: 'contains', expected: '1920' },
      { name: 'mentions_45', weight: 1, evaluator: 'regex', expected: '\\b4[4-6]\\b' },
      { name: 'correctness', weight: 4, evaluator: 'llm_judge', expected: 'Did the agent identify Frank Herbert (born 1920), the 1965 publication, compute age 45, and cite sources?' },
    ],
    timeoutMs: 180_000,
    tools: ['web_search', 'web_fetch'],
  },
]
