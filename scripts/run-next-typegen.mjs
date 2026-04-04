#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { ensureBuildBootstrapPaths } from './build-bootstrap-env.mjs'

const require = createRequire(import.meta.url)

export const TYPEGEN_ARTIFACT_PATHS = [
  '.next/types',
  '.next/dev/types',
  'tsconfig.tsbuildinfo',
]

export function cleanupTypegenArtifacts(cwd = process.cwd()) {
  for (const relativePath of TYPEGEN_ARTIFACT_PATHS) {
    fs.rmSync(path.join(cwd, relativePath), { recursive: true, force: true })
  }
}

export function buildNextTypegenEnv(env = process.env, cwd = process.cwd()) {
  const bootstrapPaths = ensureBuildBootstrapPaths(cwd)
  return {
    ...env,
    DATA_DIR: bootstrapPaths.dataDir,
    WORKSPACE_DIR: bootstrapPaths.workspaceDir,
    BROWSER_PROFILES_DIR: bootstrapPaths.browserProfilesDir,
    SWARMCLAW_BUILD_MODE: env.SWARMCLAW_BUILD_MODE || '1',
  }
}

export function runNextTypegen(args = process.argv.slice(2), env = process.env, cwd = process.cwd()) {
  cleanupTypegenArtifacts(cwd)
  const nextBin = require.resolve('next/dist/bin/next')
  return spawnSync(process.execPath, [nextBin, 'typegen', ...args], {
    stdio: 'inherit',
    env: buildNextTypegenEnv(env, cwd),
    cwd,
  })
}

function main() {
  const result = runNextTypegen()
  if (result.error) throw result.error
  if (typeof result.status === 'number') {
    process.exit(result.status)
  }
  if (result.signal) {
    process.kill(process.pid, result.signal)
    return
  }
  process.exit(1)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main()
}
