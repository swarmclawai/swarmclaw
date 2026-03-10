import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, it } from 'node:test'
import { resolveDevServerLaunchDir } from '@/lib/server/runtime/devserver-launch'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()
    if (!dir) continue
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-devserver-launch-'))
  tempDirs.push(dir)
  return dir
}

describe('resolveDevServerLaunchDir', () => {
  it('resolves the repo root when launched from src/app', () => {
    const repoRoot = path.resolve(process.cwd())
    const nested = path.join(repoRoot, 'src', 'app')
    const result = resolveDevServerLaunchDir(nested)
    assert.equal(result.launchDir, repoRoot)
    assert.equal(result.packageRoot, repoRoot)
    assert.equal(result.framework, 'next')
  })

  it('returns the nearest npm package root for nested package folders', () => {
    const root = makeTempDir()
    const nested = path.join(root, 'src', 'feature')
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'fixture',
      scripts: { dev: 'vite' },
      devDependencies: { vite: '^6.0.0' },
    }))

    const result = resolveDevServerLaunchDir(nested)
    assert.equal(result.launchDir, root)
    assert.equal(result.packageRoot, root)
    assert.equal(result.framework, 'npm')
  })

  it('falls back to the input directory when no package root exists', () => {
    const root = makeTempDir()
    const nested = path.join(root, 'plain', 'folder')
    fs.mkdirSync(nested, { recursive: true })

    const result = resolveDevServerLaunchDir(nested)
    assert.equal(result.launchDir, nested)
    assert.equal(result.packageRoot, null)
    assert.equal(result.framework, 'unknown')
  })
})
