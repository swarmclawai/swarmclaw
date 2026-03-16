#!/usr/bin/env node
import { runAgentRegressionSuite, type RegressionApprovalMode, type RegressionExtensionMode } from '../src/lib/server/eval/agent-regression'
import { appendSessionNote } from '../src/lib/server/session-note'
import { loadAgents } from '../src/lib/server/storage'

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

function parseExtensionMode(raw: string | null): RegressionExtensionMode | undefined {
  if (!raw) return undefined
  return raw === 'agent' ? 'agent' : raw === 'scenario' ? 'scenario' : undefined
}

async function main() {
  const result = await runAgentRegressionSuite({
    agentId: readFlag('--agent') || 'default',
    approvalModes: parseApprovalModes(readFlag('--modes')),
    scenarioIds: parseList(readFlag('--scenarios')),
    extensionMode: parseExtensionMode(readFlag('--extension-mode')),
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
      extensionMode: scenario.extensionMode,
      status: scenario.status,
      score: scenario.score,
      maxScore: scenario.maxScore,
      missingExtensions: scenario.missingExtensions,
      failedAssertions: scenario.assertions.filter((assertion) => !assertion.passed).map((assertion) => assertion.name),
    })),
  }

  console.log(JSON.stringify(payload, null, 2))

  const agent = (loadAgents() as unknown as Record<string, Record<string, unknown>>)[result.agentId]
  const threadSessionId = typeof agent?.threadSessionId === 'string' ? agent.threadSessionId : ''
  if (threadSessionId) {
    const failedScenarios = result.scenarios.filter((scenario) => scenario.status !== 'passed')
    const lines = [
      '## Live Test Report',
      '',
      `Regression suite for **${result.agentId}** completed.`,
      '',
      `- Suite ID: \`${result.id}\``,
      `- Score: **${result.score}/${result.maxScore}**`,
      `- Approval modes: ${result.approvalModes.join(', ')}`,
      `- Results: \`${result.resultsPath}\``,
    ]
    if (failedScenarios.length) {
      lines.push('', '### Attention', '')
      for (const scenario of failedScenarios.slice(0, 6)) {
        const failures = scenario.assertions.filter((assertion) => !assertion.passed).map((assertion) => assertion.name)
        lines.push(`- **${scenario.scenarioId}** (${scenario.approvalMode}, ${scenario.status}): ${failures.join(', ') || 'Check results file for details'}`)
      }
    }
    appendSessionNote({
      sessionId: threadSessionId,
      text: lines.join('\n'),
      role: 'assistant',
      kind: 'system',
    })
  }

  if (hasFlag('--fail-on-regression') && result.score < result.maxScore) {
    process.exitCode = 1
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack || error.message : String(error)
  console.error(message)
  process.exit(1)
})
