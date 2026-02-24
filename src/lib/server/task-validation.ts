import type { BoardTask } from '@/types'
import type { TaskReportArtifact } from './task-reports'

export interface TaskCompletionValidation {
  ok: boolean
  reasons: string[]
  checkedAt: number
}

interface TaskCompletionValidationOptions {
  report?: TaskReportArtifact | null
}

const MIN_RESULT_CHARS = 40

const WEAK_RESULT_PATTERNS: RegExp[] = [
  /what can i help you with/i,
  /waiting for approval/i,
  /now let me write/i,
  /what'?s the play/i,
  /\bthe plan covers\b/i,
  /now update the agent/i,
  /\bzero typescript errors\b/i,
]

const IMPLEMENTATION_HINT = /\b(add|build|create|fix|implement|integrat|refactor|update|write)\b/i
const EXECUTION_EVIDENCE = /\b(changed|updated|added|modified|files?|commands?|tests?|build|lint|typecheck|verified|report)\b/i
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

  if (error) reasons.push('Task has a non-empty error field.')

  if (!result) reasons.push('Result summary is empty.')
  else {
    if (result.length < MIN_RESULT_CHARS) reasons.push(`Result summary is too short (${result.length} chars).`)
    if (WEAK_RESULT_PATTERNS.some((rx) => rx.test(result))) {
      reasons.push('Result contains placeholder/planning language instead of completion evidence.')
    }
  }

  // If task description/title suggests implementation work, require concrete evidence in
  // the result summary OR task report.
  const implementationTask = IMPLEMENTATION_HINT.test(title) || IMPLEMENTATION_HINT.test(description)
  const hasResultEvidence = EXECUTION_EVIDENCE.test(result)
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

  return {
    ok: reasons.length === 0,
    reasons,
    checkedAt: Date.now(),
  }
}

export function formatValidationFailure(reasons: string[]): string {
  return `Completion validation failed: ${reasons.join(' ')}`
}
