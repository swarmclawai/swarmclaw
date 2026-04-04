#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

export const BUILD_BOOTSTRAP_ROOT_NAME = '.tmp-swarmclaw-build'

export function resolveBuildBootstrapPaths(cwd = process.cwd()) {
  const rootDir = path.join(cwd, BUILD_BOOTSTRAP_ROOT_NAME)
  return {
    rootDir,
    dataDir: path.join(rootDir, 'data'),
    workspaceDir: path.join(rootDir, 'workspace'),
    browserProfilesDir: path.join(rootDir, 'browser-profiles'),
  }
}

export function ensureBuildBootstrapPaths(cwd = process.cwd()) {
  const paths = resolveBuildBootstrapPaths(cwd)
  for (const dir of [paths.rootDir, paths.dataDir, paths.workspaceDir, paths.browserProfilesDir]) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return paths
}
