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

function detectPackageManager(rootDir, env = process.env) {
  if (fs.existsSync(path.join(rootDir, 'bun.lock')) || fs.existsSync(path.join(rootDir, 'bun.lockb'))) return 'bun'
  if (fs.existsSync(path.join(rootDir, 'pnpm-lock.yaml'))) return 'pnpm'
  if (fs.existsSync(path.join(rootDir, 'yarn.lock'))) return 'yarn'
  if (fs.existsSync(path.join(rootDir, 'package-lock.json'))) return 'npm'

  const userAgent = String(env.npm_config_user_agent || '').toLowerCase()
  if (userAgent.startsWith('pnpm/')) return 'pnpm'
  if (userAgent.startsWith('yarn/')) return 'yarn'
  if (userAgent.startsWith('bun/')) return 'bun'
  if (userAgent.startsWith('npm/')) return 'npm'
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
  switch (packageManager) {
    case 'pnpm':
      return `pnpm add -g ${packageName}@latest`
    case 'yarn':
      return `yarn global add ${packageName}@latest`
    case 'bun':
      return `bun add -g ${packageName}@latest`
    case 'npm':
    default:
      return `npm update -g ${packageName}`
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
  getGlobalUpdateCommand,
  getInstallCommand,
  getRunScriptCommand,
  LOCKFILE_NAMES,
}
