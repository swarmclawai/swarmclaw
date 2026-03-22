import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..')
const srcRoot = path.join(repoRoot, 'src')

const ALLOWED_IMPORTERS = new Set([
  path.join(srcRoot, 'lib/server/chat-execution/chat-execution.ts'),
  path.join(srcRoot, 'lib/server/execution-engine/chat-turn.ts'),
])

function walk(dir: string): string[] {
  const results: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...walk(fullPath))
      continue
    }
    if (!/\.(?:ts|tsx|js|mjs)$/.test(entry.name)) continue
    if (entry.name.includes('.test.')) continue
    results.push(fullPath)
  }
  return results
}

describe('executeSessionChatTurn import boundary', () => {
  it('is only imported through the execution-engine chat-turn wrapper', () => {
    const offenders: string[] = []
    const importPattern = /import\s*\{[^}]*\bexecuteSessionChatTurn\b[^}]*\}\s*from\s*['"][^'"]+['"]/m

    for (const filePath of walk(srcRoot)) {
      if (ALLOWED_IMPORTERS.has(filePath)) continue
      const contents = fs.readFileSync(filePath, 'utf8')
      if (importPattern.test(contents)) {
        offenders.push(path.relative(repoRoot, filePath))
      }
    }

    assert.deepEqual(offenders, [])
  })
})
