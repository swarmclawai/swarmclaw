#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { ESLint } from 'eslint'

const BASELINE_FILE = path.resolve(
  process.cwd(),
  process.env.ESLINT_BASELINE_FILE || '.eslint-baseline.json',
)
const args = process.argv.slice(2)
const MODE = args[0] === 'update' ? 'update' : 'check'
const ISSUE_SEVERITY = {
  1: 'warning',
  2: 'error',
}

function parseOptions(argv) {
  const options = {
    reportJson: '',
    reportMd: '',
    maxPreview: 50,
  }

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = argv[index + 1]
    if (arg === '--report-json' && next) {
      options.reportJson = next
      index += 1
      continue
    }
    if (arg === '--report-md' && next) {
      options.reportMd = next
      index += 1
      continue
    }
    if (arg === '--max-preview' && next) {
      const parsed = Number.parseInt(next, 10)
      if (Number.isFinite(parsed) && parsed > 0) options.maxPreview = parsed
      index += 1
    }
  }

  return options
}

function normalizeMessage(message) {
  return String(message || '').replace(/\s+/g, ' ').trim()
}

function toIssueKey(filePath, ruleId, severity, message) {
  return JSON.stringify([filePath, ruleId, severity, message])
}

function fromIssueKey(key) {
  const [filePath, ruleId, severity, message] = JSON.parse(key)
  return { filePath, ruleId, severity, message }
}

function compareIssueRows(a, b) {
  if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath)
  if (a.severity !== b.severity) return a.severity - b.severity
  if (a.ruleId !== b.ruleId) return a.ruleId.localeCompare(b.ruleId)
  return a.message.localeCompare(b.message)
}

function mapToRows(issueCounts) {
  return Array.from(issueCounts.entries())
    .map(([key, count]) => {
      const parsed = fromIssueKey(key)
      return {
        ...parsed,
        count,
      }
    })
    .sort(compareIssueRows)
}

function rowsToMap(rows) {
  const map = new Map()
  for (const row of rows || []) {
    const key = toIssueKey(
      row.filePath,
      row.ruleId,
      Number(row.severity),
      normalizeMessage(row.message),
    )
    map.set(key, Number(row.count) || 0)
  }
  return map
}

function escapeMarkdownCell(value) {
  return String(value).replace(/\|/g, '\\|')
}

function toMarkdownReport({
  baselineTotal,
  currentTotal,
  regressions,
  maxPreview,
}) {
  const sorted = [...regressions].sort(compareIssueRows)
  const preview = sorted.slice(0, maxPreview)
  const header = regressions.length > 0
    ? `## Lint Baseline Regression\n\nNet-new lint fingerprints: **${regressions.length}**\n\nBaseline total issues: **${baselineTotal}**\nCurrent total issues: **${currentTotal}**\n`
    : `## Lint Baseline\n\nNo net-new lint issues detected.\n\nBaseline total issues: **${baselineTotal}**\nCurrent total issues: **${currentTotal}**\n`

  if (preview.length === 0) return `${header}\n`

  const rows = [
    '| File | Severity | Rule | Delta | Message |',
    '|---|---:|---|---:|---|',
  ]
  for (const item of preview) {
    rows.push(
      `| ${escapeMarkdownCell(item.filePath)} | ${escapeMarkdownCell(ISSUE_SEVERITY[item.severity] || item.severity)} | ${escapeMarkdownCell(item.ruleId)} | +${item.count} | ${escapeMarkdownCell(item.message)} |`,
    )
  }
  const remainder = regressions.length - preview.length
  const suffix = remainder > 0 ? `\nShowing first ${preview.length} rows. ${remainder} more not shown.\n` : '\n'
  return `${header}\n${rows.join('\n')}\n${suffix}`
}

function ensureParentDir(filePath) {
  const parent = path.dirname(filePath)
  if (parent && parent !== '.') fs.mkdirSync(parent, { recursive: true })
}

function writeReports(options, report) {
  if (options.reportJson) {
    ensureParentDir(options.reportJson)
    fs.writeFileSync(options.reportJson, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  }
  if (options.reportMd) {
    ensureParentDir(options.reportMd)
    fs.writeFileSync(
      options.reportMd,
      toMarkdownReport({
        baselineTotal: report.baselineTotal,
        currentTotal: report.currentTotal,
        regressions: report.regressions,
        maxPreview: options.maxPreview,
      }),
      'utf8',
    )
  }
}

async function collectIssueCounts() {
  const eslint = new ESLint()
  const results = await eslint.lintFiles(['.'])
  const issueCounts = new Map()

  for (const result of results) {
    const filePath = path.relative(process.cwd(), result.filePath).replaceAll('\\', '/')
    for (const message of result.messages) {
      if (!message || !message.severity) continue
      const ruleId = message.ruleId || '(eslint)'
      const severity = Number(message.severity)
      const normalized = normalizeMessage(message.message)
      const key = toIssueKey(filePath, ruleId, severity, normalized)
      issueCounts.set(key, (issueCounts.get(key) || 0) + 1)
    }
  }

  return issueCounts
}

function loadBaselineMap() {
  if (!fs.existsSync(BASELINE_FILE)) return null
  const parsed = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'))
  return rowsToMap(parsed.issues)
}

function saveBaseline(issueCounts) {
  const rows = mapToRows(issueCounts)
  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    totalIssues: rows.reduce((sum, row) => sum + row.count, 0),
    uniqueIssues: rows.length,
    issues: rows,
  }
  fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  console.log(
    `Wrote baseline with ${payload.totalIssues} issues (${payload.uniqueIssues} unique fingerprints) to ${path.basename(BASELINE_FILE)}.`,
  )
}

function reportRegressions(regressions, maxPreview) {
  const sorted = regressions.sort(compareIssueRows)
  const preview = sorted.slice(0, maxPreview)
  console.error(`Found ${sorted.length} net-new lint fingerprint(s):`)
  for (const item of preview) {
    const severityLabel = ISSUE_SEVERITY[item.severity] || String(item.severity)
    console.error(
      `- ${item.filePath} [${severityLabel}] ${item.ruleId} (+${item.count}): ${item.message}`,
    )
  }
  if (sorted.length > preview.length) {
    console.error(`...and ${sorted.length - preview.length} more.`)
  }
}

async function main() {
  const options = parseOptions(args)
  const current = await collectIssueCounts()

  if (MODE === 'update') {
    saveBaseline(current)
    return
  }

  const baseline = loadBaselineMap()
  if (!baseline) {
    console.error(`Missing ${path.basename(BASELINE_FILE)}. Run: npm run lint:baseline:update`)
    process.exit(1)
  }

  const regressions = []
  for (const [key, count] of current.entries()) {
    const allowed = baseline.get(key) || 0
    if (count > allowed) {
      const item = fromIssueKey(key)
      regressions.push({
        ...item,
        count: count - allowed,
      })
    }
  }

  const baselineTotal = Array.from(baseline.values()).reduce((sum, count) => sum + count, 0)
  const currentTotal = Array.from(current.values()).reduce((sum, count) => sum + count, 0)
  const reportPayload = {
    mode: MODE,
    baselineFile: path.basename(BASELINE_FILE),
    baselineTotal,
    currentTotal,
    netNewFingerprints: regressions.length,
    regressions: regressions.sort(compareIssueRows),
  }
  writeReports(options, reportPayload)

  if (regressions.length > 0) {
    reportRegressions(regressions, options.maxPreview)
    console.error(
      `Baseline total: ${baselineTotal}. Current total: ${currentTotal}. Fix new issues or refresh baseline intentionally.`,
    )
    process.exit(1)
  }

  if (currentTotal < baselineTotal) {
    console.log(
      `Lint debt improved by ${baselineTotal - currentTotal} issue(s). Run npm run lint:baseline:update to record the lower baseline.`,
    )
  } else {
    console.log(`No net-new lint issues detected (${currentTotal} current vs ${baselineTotal} baseline).`)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error)
  process.exit(1)
})
