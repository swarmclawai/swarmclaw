#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { ensureBuildBootstrapPaths } from './build-bootstrap-env.mjs'

const require = createRequire(import.meta.url)

export const DEFAULT_MAX_OLD_SPACE_SIZE_MB = '8192'
export const TRACE_COPY_WARNING = 'Failed to copy traced files'

export function mergeNodeOptions(nodeOptions = '', maxOldSpaceSizeMb = DEFAULT_MAX_OLD_SPACE_SIZE_MB) {
  const trimmed = nodeOptions.trim()
  if (/(^|\s)--max-old-space-size(?:=|\s|$)/.test(trimmed)) return trimmed
  return trimmed
    ? `${trimmed} --max-old-space-size=${maxOldSpaceSizeMb}`
    : `--max-old-space-size=${maxOldSpaceSizeMb}`
}

export function buildNextBuildEnv(
  env = process.env,
  maxOldSpaceSizeMb = DEFAULT_MAX_OLD_SPACE_SIZE_MB,
  cwd = process.cwd(),
) {
  const bootstrapPaths = ensureBuildBootstrapPaths(cwd)
  return {
    ...env,
    DATA_DIR: bootstrapPaths.dataDir,
    WORKSPACE_DIR: bootstrapPaths.workspaceDir,
    BROWSER_PROFILES_DIR: bootstrapPaths.browserProfilesDir,
    NODE_OPTIONS: mergeNodeOptions(env.NODE_OPTIONS || '', maxOldSpaceSizeMb),
    SWARMCLAW_BUILD_MODE: env.SWARMCLAW_BUILD_MODE || '1',
  }
}

export function hasTraceCopyWarning(output = '') {
  return output.includes(TRACE_COPY_WARNING)
}

export function runNextBuild(args = process.argv.slice(2), env = process.env, cwd = process.cwd()) {
  const nextBin = require.resolve('next/dist/bin/next')
  return spawnSync(process.execPath, [nextBin, 'build', '--webpack', ...args], {
    stdio: 'pipe',
    encoding: 'utf-8',
    env: buildNextBuildEnv(env, DEFAULT_MAX_OLD_SPACE_SIZE_MB, cwd),
    cwd,
  })
}

function main() {
  const result = runNextBuild()
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) throw result.error
  const combinedOutput = `${result.stdout || ''}\n${result.stderr || ''}`
  if ((result.status ?? 1) === 0 && hasTraceCopyWarning(combinedOutput)) {
    console.error('Build emitted standalone trace copy warnings; failing to keep CI deterministic.')
    process.exit(1)
  }
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
