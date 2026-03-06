#!/usr/bin/env node
import { runAgentRegressionSuite, type RegressionApprovalMode } from '../src/lib/server/eval/agent-regression'

function readFlag(name: string): string | null {
  const index = process.argv.indexOf(name)
  if (index === -1) return null
  return process.argv[index + 1] || null
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name)
}

function parseApprovalModes(raw: string | null): RegressionApprovalMode[] | undefined {
  if (!raw) return undefined
  const parsed = raw.split(',').map((value) => value.trim()).filter(Boolean)
  const valid = parsed.filter((value): value is RegressionApprovalMode => value === 'manual' || value === 'auto' || value === 'off')
  return valid.length ? valid : undefined
}

function parseList(raw: string | null): string[] | undefined {
  if (!raw) return undefined
  const parsed = raw.split(',').map((value) => value.trim()).filter(Boolean)
  return parsed.length ? parsed : undefined
}

async function main() {
  const result = await runAgentRegressionSuite({
    agentId: readFlag('--agent') || 'default',
    approvalModes: parseApprovalModes(readFlag('--modes')),
    scenarioIds: parseList(readFlag('--scenarios')),
  })

  const payload = {
    id: result.id,
    agentId: result.agentId,
    approvalModes: result.approvalModes,
    score: result.score,
    maxScore: result.maxScore,
    resultsPath: result.resultsPath,
    scenarios: result.scenarios.map((scenario) => ({
      scenarioId: scenario.scenarioId,
      approvalMode: scenario.approvalMode,
      status: scenario.status,
      score: scenario.score,
      maxScore: scenario.maxScore,
      failedAssertions: scenario.assertions.filter((assertion) => !assertion.passed).map((assertion) => assertion.name),
    })),
  }

  console.log(JSON.stringify(payload, null, 2))

  if (hasFlag('--fail-on-regression') && result.score < result.maxScore) {
    process.exitCode = 1
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack || error.message : String(error)
  console.error(message)
  process.exit(1)
})
