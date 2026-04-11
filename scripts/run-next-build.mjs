#!/usr/bin/env node

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { ensureBuildBootstrapPaths } from './build-bootstrap-env.mjs'

const require = createRequire(import.meta.url)

export const DEFAULT_MAX_OLD_SPACE_SIZE_MB = '8192'
export const MIN_MAX_OLD_SPACE_SIZE_MB = 1024
export const FALLBACK_MIN_MAX_OLD_SPACE_SIZE_MB = 512
export const RESERVED_BUILD_MEMORY_MB = 768
export const MAX_OLD_SPACE_RATIO = 0.75
export const LOW_MEMORY_RATIO = 0.6
export const BUILD_MAX_OLD_SPACE_SIZE_ENV = 'SWARMCLAW_BUILD_MAX_OLD_SPACE_SIZE_MB'
export const CGROUP_MEMORY_LIMIT_PATHS = [
  '/sys/fs/cgroup/memory.max',
  '/sys/fs/cgroup/memory/memory.limit_in_bytes',
]
export const UNBOUNDED_MEMORY_LIMIT_BYTES = 1n << 60n
export const TRACE_COPY_WARNING = 'Failed to copy traced files'
export const NEXT_STANDALONE_METADATA_RELATIVE_DIR = path.join(
  'node_modules',
  'next',
  'dist',
  'lib',
  'metadata',
)
export const REQUIRED_NEXT_METADATA_FILES = [
  'get-metadata-route.js',
  'is-metadata-route.js',
]

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

export function readCgroupMemoryLimitBytes(
  paths = CGROUP_MEMORY_LIMIT_PATHS,
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync,
) {
  for (const filePath of paths) {
    if (!existsSync(filePath)) continue

    let raw = ''
    try {
      raw = String(readFileSync(filePath, 'utf8')).trim()
    } catch {
      continue
    }

    if (!raw || raw === 'max') continue

    try {
      const bytes = BigInt(raw)
      if (bytes <= 0n || bytes >= UNBOUNDED_MEMORY_LIMIT_BYTES) continue
      return Number(bytes)
    } catch {
      continue
    }
  }

  return null
}

export function deriveMaxOldSpaceSizeMb(memoryLimitBytes, defaultMaxOldSpaceSizeMb = DEFAULT_MAX_OLD_SPACE_SIZE_MB) {
  const defaultMb = parsePositiveInteger(defaultMaxOldSpaceSizeMb) ?? Number.parseInt(DEFAULT_MAX_OLD_SPACE_SIZE_MB, 10)
  const limitMb = Math.floor(Number(memoryLimitBytes) / (1024 * 1024))
  if (!Number.isFinite(limitMb) || limitMb <= 0) return String(defaultMb)

  const constrainedCandidate = Math.min(
    defaultMb,
    limitMb - RESERVED_BUILD_MEMORY_MB,
    Math.floor(limitMb * MAX_OLD_SPACE_RATIO),
  )
  if (constrainedCandidate >= MIN_MAX_OLD_SPACE_SIZE_MB) {
    return String(constrainedCandidate)
  }

  return String(Math.max(
    FALLBACK_MIN_MAX_OLD_SPACE_SIZE_MB,
    Math.min(defaultMb, Math.floor(limitMb * LOW_MEMORY_RATIO)),
  ))
}

export function resolveNextBuildMaxOldSpaceSizeMb(
  env = process.env,
  options = {},
) {
  const explicit = parsePositiveInteger(env[BUILD_MAX_OLD_SPACE_SIZE_ENV])
  if (explicit) return String(explicit)

  const readLimitBytes = options.readCgroupMemoryLimitBytes ?? readCgroupMemoryLimitBytes
  const totalMemFn = options.totalMem ?? os.totalmem
  const memoryLimitBytes = readLimitBytes() ?? totalMemFn()

  return deriveMaxOldSpaceSizeMb(memoryLimitBytes, DEFAULT_MAX_OLD_SPACE_SIZE_MB)
}

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

function hasRequiredNextMetadataFiles(dir) {
  return REQUIRED_NEXT_METADATA_FILES.every((fileName) => fs.existsSync(path.join(dir, fileName)))
}

export function repairStandalonePublicAndStatic(cwd = process.cwd()) {
  const standaloneDir = path.join(cwd, '.next', 'standalone')
  if (!fs.existsSync(standaloneDir)) return false

  let repaired = false

  // Next.js standalone does not copy public/ or .next/static/ automatically.
  const publicSrc = path.join(cwd, 'public')
  const publicDst = path.join(standaloneDir, 'public')
  if (fs.existsSync(publicSrc) && !fs.existsSync(publicDst)) {
    fs.cpSync(publicSrc, publicDst, { recursive: true, force: true })
    repaired = true
  }

  const staticSrc = path.join(cwd, '.next', 'static')
  const staticDst = path.join(standaloneDir, '.next', 'static')
  if (fs.existsSync(staticSrc) && !fs.existsSync(staticDst)) {
    fs.cpSync(staticSrc, staticDst, { recursive: true, force: true })
    repaired = true
  }

  return repaired
}

export function repairStandaloneCssTreeData(cwd = process.cwd()) {
  const standaloneDir = path.join(cwd, '.next', 'standalone')
  if (!fs.existsSync(standaloneDir)) return false

  const dataDst = path.join(standaloneDir, 'node_modules', 'css-tree', 'data')
  if (fs.existsSync(dataDst)) return false

  const dataSrc = path.join(cwd, 'node_modules', 'css-tree', 'data')
  if (!fs.existsSync(dataSrc)) return false

  fs.cpSync(dataSrc, dataDst, { recursive: true, force: true })
  return true
}

export function repairStandaloneNextMetadata(cwd = process.cwd()) {
  const standaloneDir = path.join(cwd, '.next', 'standalone')
  if (!fs.existsSync(standaloneDir)) return false

  const standaloneMetadataDir = path.join(standaloneDir, NEXT_STANDALONE_METADATA_RELATIVE_DIR)
  if (hasRequiredNextMetadataFiles(standaloneMetadataDir)) return false

  const installedMetadataDir = path.join(cwd, 'node_modules', 'next', 'dist', 'lib', 'metadata')
  if (!hasRequiredNextMetadataFiles(installedMetadataDir)) {
    throw new Error(
      `Missing required Next metadata runtime files under ${installedMetadataDir}.`,
    )
  }

  fs.mkdirSync(path.dirname(standaloneMetadataDir), { recursive: true })
  fs.cpSync(installedMetadataDir, standaloneMetadataDir, { recursive: true, force: true })

  if (!hasRequiredNextMetadataFiles(standaloneMetadataDir)) {
    throw new Error(
      `Failed to repair Next metadata runtime files under ${standaloneMetadataDir}.`,
    )
  }

  return true
}

export function runNextBuild(
  args = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  maxOldSpaceSizeMb = resolveNextBuildMaxOldSpaceSizeMb(env),
) {
  const nextBin = require.resolve('next/dist/bin/next')
  return spawnSync(process.execPath, [nextBin, 'build', '--webpack', ...args], {
    stdio: 'pipe',
    encoding: 'utf-8',
    env: buildNextBuildEnv(env, maxOldSpaceSizeMb, cwd),
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
    if (result.status === 0 && repairStandaloneNextMetadata(process.cwd())) {
      console.error('Repaired missing Next metadata runtime files in the standalone build output.')
    }
    if (result.status === 0 && repairStandalonePublicAndStatic(process.cwd())) {
      console.error('Copied public/ and .next/static/ into standalone build output.')
    }
    if (result.status === 0 && repairStandaloneCssTreeData(process.cwd())) {
      console.error('Copied css-tree/data/ into standalone build output.')
    }
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
