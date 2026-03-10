import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const serverDir = path.resolve(path.dirname(new URL(import.meta.url).pathname))

test('orchestrator runtime shares tool and graph builders between start and resume flows', () => {
  const src = fs.readFileSync(path.join(serverDir, 'orchestrator-lg.ts'), 'utf-8')

  assert.equal(src.includes('function createOrchestratorTools('), true)
  assert.equal(src.includes('function compileOrchestratorGraph('), true)
  assert.equal((src.match(/createOrchestratorTools\(/g) || []).length >= 3, true)
  assert.equal((src.match(/compileOrchestratorGraph\(/g) || []).length >= 3, true)
  assert.equal((src.match(/const createTaskTool = tool\(/g) || []).length, 1)
  assert.equal((src.match(/const commentOnTaskTool = tool\(/g) || []).length, 1)
})
