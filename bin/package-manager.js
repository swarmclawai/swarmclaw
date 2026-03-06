'use strict'
/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require('node:fs')
const path = require('node:path')

const LOCKFILE_NAMES = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
]
const INSTALL_METADATA_FILE = '.swarmclaw-install.json'

function normalizePackageManager(raw) {
  switch (String(raw || '').trim().toLowerCase()) {
    case 'pnpm':
    case 'yarn':
    case 'bun':
    case 'npm':
      return String(raw).trim().toLowerCase()
    default:
      return null
  }
}

function detectPackageManagerFromUserAgent(userAgent) {
  const normalized = String(userAgent || '').toLowerCase()
  if (normalized.startsWith('pnpm/')) return 'pnpm'
  if (normalized.startsWith('yarn/')) return 'yarn'
  if (normalized.startsWith('bun/')) return 'bun'
  if (normalized.startsWith('npm/')) return 'npm'
  return null
}

function readInstallMetadata(rootDir) {
  const metadataPath = path.join(rootDir, INSTALL_METADATA_FILE)
  if (!fs.existsSync(metadataPath)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
    return raw && typeof raw === 'object' ? raw : null
  } catch {
    return null
  }
}

function detectPackageManager(rootDir, env = process.env) {
  const envOverride = normalizePackageManager(env.SWARMCLAW_PACKAGE_MANAGER)
  if (envOverride) return envOverride

  const installMetadata = readInstallMetadata(rootDir)
  const installManager = normalizePackageManager(installMetadata?.packageManager)
  if (installManager) return installManager

  if (fs.existsSync(path.join(rootDir, 'bun.lock')) || fs.existsSync(path.join(rootDir, 'bun.lockb'))) return 'bun'
  if (fs.existsSync(path.join(rootDir, 'pnpm-lock.yaml'))) return 'pnpm'
  if (fs.existsSync(path.join(rootDir, 'yarn.lock'))) return 'yarn'
  if (fs.existsSync(path.join(rootDir, 'package-lock.json'))) return 'npm'

  const userAgentManager = detectPackageManagerFromUserAgent(env.npm_config_user_agent)
  if (userAgentManager) return userAgentManager
  return 'npm'
}

function getInstallCommand(packageManager, omitDev = false) {
  switch (packageManager) {
    case 'pnpm':
      return omitDev
        ? { command: 'pnpm', args: ['install', '--prod'] }
        : { command: 'pnpm', args: ['install'] }
    case 'yarn':
      return omitDev
        ? { command: 'yarn', args: ['install', '--production=true'] }
        : { command: 'yarn', args: ['install'] }
    case 'bun':
      return omitDev
        ? { command: 'bun', args: ['install', '--production'] }
        : { command: 'bun', args: ['install'] }
    case 'npm':
    default:
      return omitDev
        ? { command: 'npm', args: ['install', '--omit=dev'] }
        : { command: 'npm', args: ['install'] }
  }
}

function getGlobalUpdateCommand(packageManager, packageName) {
  return getGlobalUpdateSpec(packageManager, packageName).display
}

function getGlobalUpdateSpec(packageManager, packageName) {
  switch (packageManager) {
    case 'pnpm':
      return {
        command: 'pnpm',
        args: ['add', '-g', `${packageName}@latest`],
        display: `pnpm add -g ${packageName}@latest`,
      }
    case 'yarn':
      return {
        command: 'yarn',
        args: ['global', 'add', `${packageName}@latest`],
        display: `yarn global add ${packageName}@latest`,
      }
    case 'bun':
      return {
        command: 'bun',
        args: ['add', '-g', `${packageName}@latest`],
        display: `bun add -g ${packageName}@latest`,
      }
    case 'npm':
    default:
      return {
        command: 'npm',
        args: ['update', '-g', packageName],
        display: `npm update -g ${packageName}`,
      }
  }
}

function getRunScriptCommand(packageManager, scriptName) {
  switch (packageManager) {
    case 'pnpm':
      return { command: 'pnpm', args: [scriptName] }
    case 'yarn':
      return { command: 'yarn', args: [scriptName] }
    case 'bun':
      return { command: 'bun', args: ['run', scriptName] }
    case 'npm':
    default:
      return { command: 'npm', args: ['run', scriptName] }
  }
}

function dependenciesChanged(diffText) {
  if (!diffText) return false
  return String(diffText)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .some((file) => file === 'package.json' || LOCKFILE_NAMES.includes(file))
}

module.exports = {
  dependenciesChanged,
  detectPackageManager,
  detectPackageManagerFromUserAgent,
  getGlobalUpdateCommand,
  getGlobalUpdateSpec,
  getInstallCommand,
  getRunScriptCommand,
  INSTALL_METADATA_FILE,
  LOCKFILE_NAMES,
  normalizePackageManager,
  readInstallMetadata,
}
