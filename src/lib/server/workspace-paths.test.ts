import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'

import { normalizeLegacyWorkspacePath } from './workspace-paths'

const ROOT = '/app/data/workspace'

test('remaps a legacy .swarmclaw workspace task path onto the current root', () => {
  assert.equal(
    normalizeLegacyWorkspacePath('/root/.swarmclaw/workspace/tasks/a974c8b0', { workspaceRoot: ROOT }),
    path.join(ROOT, 'tasks', 'a974c8b0'),
  )
})

test('remaps the home-dir default workspace root', () => {
  const legacy = path.join(os.homedir(), '.swarmclaw', 'workspace', 'projects', 'site')
  assert.equal(
    normalizeLegacyWorkspacePath(legacy, { workspaceRoot: ROOT }),
    path.join(ROOT, 'projects', 'site'),
  )
})

test('remaps a non-.swarmclaw legacy root when the tail matches tasks/<taskId>', () => {
  assert.equal(
    normalizeLegacyWorkspacePath('/old/home/workspace/tasks/abc123', { workspaceRoot: ROOT, taskId: 'abc123' }),
    path.join(ROOT, 'tasks', 'abc123'),
  )
})

test('remaps subdirectories under a matching tasks/<taskId> tail', () => {
  assert.equal(
    normalizeLegacyWorkspacePath('/old/home/workspace/tasks/abc123/output', { workspaceRoot: ROOT, taskId: 'abc123' }),
    path.join(ROOT, 'tasks', 'abc123', 'output'),
  )
})

test('does not remap when the taskId does not match the tail', () => {
  const input = '/old/home/workspace/tasks/othertask'
  assert.equal(normalizeLegacyWorkspacePath(input, { workspaceRoot: ROOT, taskId: 'abc123' }), input)
})

test('does not remap intentional custom cwds', () => {
  const input = '/home/me/code/myrepo'
  assert.equal(normalizeLegacyWorkspacePath(input, { workspaceRoot: ROOT, taskId: 'abc123' }), input)
})

test('does not remap an unrelated path that merely contains a workspace segment', () => {
  const input = '/home/me/code/workspace/notes'
  assert.equal(normalizeLegacyWorkspacePath(input, { workspaceRoot: ROOT }), input)
})

test('leaves paths already under the current root unchanged', () => {
  const input = path.join(ROOT, 'tasks', 'abc123')
  assert.equal(normalizeLegacyWorkspacePath(input, { workspaceRoot: ROOT, taskId: 'abc123' }), input)
  assert.equal(normalizeLegacyWorkspacePath(ROOT, { workspaceRoot: ROOT }), ROOT)
})

test('leaves relative and empty inputs unchanged', () => {
  assert.equal(normalizeLegacyWorkspacePath('relative/dir', { workspaceRoot: ROOT }), 'relative/dir')
  assert.equal(normalizeLegacyWorkspacePath('', { workspaceRoot: ROOT }), '')
  assert.equal(normalizeLegacyWorkspacePath(null, { workspaceRoot: ROOT }), '')
  assert.equal(normalizeLegacyWorkspacePath(undefined, { workspaceRoot: ROOT }), '')
})

test('remaps a bare legacy root with no tail to the current root', () => {
  assert.equal(
    normalizeLegacyWorkspacePath('/root/.swarmclaw/workspace', { workspaceRoot: ROOT }),
    ROOT,
  )
})
