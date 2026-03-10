import type { BoardTask } from '@/types'
import type { TaskReportArtifact } from '@/lib/server/tasks/task-reports'
import { normalizeTaskQualityGate } from '@/lib/server/tasks/task-quality-gate'

export interface TaskCompletionValidation {
  ok: boolean
  reasons: string[]
  checkedAt: number
}

interface TaskCompletionValidationOptions {
  report?: TaskReportArtifact | null
  settings?: Record<string, unknown> | null
}

const MIN_RESULT_CHARS_IMPLEMENTATION = 40
const MIN_RESULT_CHARS_GENERIC = 20

const WEAK_RESULT_PATTERNS: RegExp[] = [
  /what can i help you with/i,
  /waiting for approval/i,
  /now let me write/i,
  /what'?s the play/i,
  /\bthe plan covers\b/i,
  /now update the agent/i,
  /\bzero typescript errors\b/i,
]

const INCOMPLETE_RESULT_PATTERNS: RegExp[] = [
  /\b(?:next|then)\s*,?\s*i\s+(?:will|can|am going to)\b/i,
  /\b(?:i(?:'| a)?ll|let me)\s+(?:start|begin|proceed|continue)\b/i,
  /\b(?:once|when|after)\s+(?:the\s+)?(?:access|approval|permission)\s+(?:is|has been)\s+granted\b/i,
  /\bneed (?:more )?(?:details|information|context)\b/i,
  /\b(?:i|we)\s+(?:need|require)\s+(?:access|approval|permission)\b/i,
  /\brequested\s+(?:access|approval|permission)\b/i,
  /\bneed access to (?:the )?(?:shell|terminal|command line)\b/i,
  /\battempted to\b[^.]{0,120}\b(?:but|however)\b/i,
  /\bcould you provide\b/i,
  /\blet me know once\b/i,
  /\bthere (?:aren't|are not) any specific details\b/i,
]

const IMPLEMENTATION_HINT = /\b(add|build|create|fix|implement|integrat|refactor|update|write)\b/i
const EXECUTION_ACTION_HINT = /\b(changed|updated|added|modified|implemented|refactored|fixed|ran|executed|verified)\b/i
const COMMAND_EVIDENCE_HINT = /\b(npm|pnpm|yarn|bun|node|npx|pytest|vitest|jest|playwright|go test|cargo test|deno test|python|pip|uv|docker|git)\b/i
const FILE_PATH_EVIDENCE_HINT = /\b[\w./-]+\.(ts|tsx|js|jsx|mjs|cjs|json|md|css|scss|html|yml|yaml|sh|py|go|rs|java|kt|swift|rb|php|sql|txt)\b/i
const ARTIFACT_EVIDENCE_HINT = /(?:sandbox:)?\/api\/uploads\/[^\s)\]]+|https?:\/\/[^\s)\]]+\.(?:png|jpe?g|webp|gif|pdf|zip)\b/i
const VERIFICATION_EVIDENCE_HINT = /\b(test|tests|lint|typecheck|build)\b[^.]{0,40}\b(pass(?:ed)?|fail(?:ed)?|ok|success)\b/i
const SCREENSHOT_HINT = /\b(screenshot|screen shot|snapshot|capture)\b/i
const DELIVERY_HINT = /\b(send|deliver|return|share|upload|post|message)\b/i
const SCREENSHOT_ARTIFACT_HINT = /(?:sandbox:)?\/api\/uploads\/[^\s)\]]+|https?:\/\/[^\s)\]]+\.(?:png|jpe?g|webp|gif|pdf)\b/i
const SENT_SCREENSHOT_HINT = /\b(sent|shared|uploaded|returned)\b[^.]*\b(screenshot|snapshot|image)\b/i

function normalizeText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim()
}

export function validateTaskCompletion(
  task: Partial<BoardTask>,
  options: TaskCompletionValidationOptions = {},
): TaskCompletionValidation {
  const reasons: string[] = []
  const title = normalizeText(task.title)
  const description = normalizeText(task.description)
  const result = normalizeText(task.result)
  const error = normalizeText(task.error)
  const report = options.report || null
  const hasExplicitQualityGate = !!task.qualityGate && typeof task.qualityGate === 'object'
  const qualityGate = normalizeTaskQualityGate(task.qualityGate || null, options.settings || null)
  const implementationTask = IMPLEMENTATION_HINT.test(title) || IMPLEMENTATION_HINT.test(description)

  if (error) reasons.push('Task has a non-empty error field.')
  if (/^untitled task$/i.test(title) && !description) {
    reasons.push('Task metadata is too vague (untitled title with empty description).')
  }

  if (!result) reasons.push('Result summary is empty.')
  else {
    const minChars = implementationTask ? MIN_RESULT_CHARS_IMPLEMENTATION : MIN_RESULT_CHARS_GENERIC
    if (result.length < minChars) reasons.push(`Result summary is too short (${result.length} chars; min ${minChars}).`)
    if (WEAK_RESULT_PATTERNS.some((rx) => rx.test(result))) {
      reasons.push('Result contains placeholder/planning language instead of completion evidence.')
    }
    if (INCOMPLETE_RESULT_PATTERNS.some((rx) => rx.test(result))) {
      reasons.push('Result indicates unfinished work or missing inputs instead of completed execution.')
    }
  }

  // If task description/title suggests implementation work, require concrete evidence in
  // the result summary OR task report.
  const hasResultEvidence = (
    COMMAND_EVIDENCE_HINT.test(result)
    || ARTIFACT_EVIDENCE_HINT.test(result)
    || VERIFICATION_EVIDENCE_HINT.test(result)
    || (EXECUTION_ACTION_HINT.test(result)
      && (/\b(command|test|lint|typecheck|build|file|artifact)\b/i.test(result) || FILE_PATH_EVIDENCE_HINT.test(result)))
  )
  const hasReportEvidence = report?.evidence.hasEvidence === true
  if (implementationTask && !hasResultEvidence && !hasReportEvidence) {
    if (report?.relativePath) {
      reasons.push(`Implementation task is missing concrete execution evidence in result or ${report.relativePath}.`)
    } else {
      reasons.push('Implementation task is missing concrete execution evidence in result.')
    }
  }

  const screenshotTask = SCREENSHOT_HINT.test(title) || SCREENSHOT_HINT.test(description)
  const screenshotDeliveryTask = screenshotTask && (DELIVERY_HINT.test(title) || DELIVERY_HINT.test(description))
  if (screenshotDeliveryTask) {
    const hasScreenshotArtifact = SCREENSHOT_ARTIFACT_HINT.test(result) || SENT_SCREENSHOT_HINT.test(result)
    if (!hasScreenshotArtifact) {
      reasons.push('Screenshot delivery task is missing artifact evidence (upload link or explicit sent screenshot confirmation).')
    }
  }

  if (qualityGate.enabled && (implementationTask || hasExplicitQualityGate)) {
    if (result && result.length < qualityGate.minResultChars) {
      reasons.push(`Quality gate: result summary is shorter than required minimum (${result.length} chars; min ${qualityGate.minResultChars}).`)
    }

    const hasCommandEvidence = COMMAND_EVIDENCE_HINT.test(result) || (report?.evidence.commandsRun.length || 0) > 0
    const hasFileEvidence = FILE_PATH_EVIDENCE_HINT.test(result) || (report?.evidence.changedFiles.length || 0) > 0
    const hasVerificationEvidence = VERIFICATION_EVIDENCE_HINT.test(result) || (report?.evidence.verification.length || 0) > 0
    const hasArtifactEvidence = ARTIFACT_EVIDENCE_HINT.test(result) || ((task.artifacts?.length || 0) > 0)

    const evidenceSignals = [
      hasCommandEvidence,
      hasFileEvidence,
      hasVerificationEvidence,
      hasArtifactEvidence,
    ].filter(Boolean).length

    if (evidenceSignals < qualityGate.minEvidenceItems) {
      reasons.push(`Quality gate: insufficient completion evidence (${evidenceSignals}/${qualityGate.minEvidenceItems} required evidence signals).`)
    }
    if (qualityGate.requireVerification && !hasVerificationEvidence) {
      reasons.push('Quality gate: verification evidence is required (tests/lint/build/check output missing).')
    }
    if (qualityGate.requireArtifact && !hasArtifactEvidence) {
      reasons.push('Quality gate: artifact evidence is required (artifact URL/upload or structured artifacts list missing).')
    }
    if (qualityGate.requireReport && !report?.relativePath) {
      reasons.push('Quality gate: task completion report is required but missing.')
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
    checkedAt: Date.now(),
  }
}

export function formatValidationFailure(reasons: string[]): string {
  return `Completion validation failed: ${reasons.join(' ')}`
}
