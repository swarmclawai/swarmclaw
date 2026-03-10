import fs from 'fs'
import path from 'path'

type FrameworkKind = 'next' | 'npm' | 'unknown'

interface PackageJsonLike {
  scripts?: Record<string, unknown>
  dependencies?: Record<string, unknown>
  devDependencies?: Record<string, unknown>
}

export interface DevServerLaunchResolution {
  inputDir: string
  launchDir: string
  packageRoot: string | null
  framework: FrameworkKind
}

const NEXT_CONFIG_FILES = [
  'next.config.js',
  'next.config.mjs',
  'next.config',
]

function readPackageJson(dir: string): PackageJsonLike | null {
  const pkgPath = path.join(dir, 'package.json')
  if (!fs.existsSync(pkgPath)) return null
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as PackageJsonLike
      : null
  } catch {
    return null
  }
}

function hasNextDependency(pkg: PackageJsonLike): boolean {
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
  return typeof deps.next === 'string' && deps.next.trim().length > 0
}

function hasNextScript(pkg: PackageJsonLike): boolean {
  const scripts = Object.values(pkg.scripts || {})
  return scripts.some((value) => typeof value === 'string' && /\bnext\b/.test(value))
}

function hasNextConfig(dir: string): boolean {
  return NEXT_CONFIG_FILES.some((file) => fs.existsSync(path.join(dir, file)))
}

function classifyPackageRoot(dir: string, pkg: PackageJsonLike): FrameworkKind {
  return hasNextDependency(pkg) || hasNextScript(pkg) || hasNextConfig(dir)
    ? 'next'
    : 'npm'
}

export function resolveDevServerLaunchDir(startDir: string): DevServerLaunchResolution {
  const inputDir = path.resolve(startDir)
  let current = inputDir

  while (true) {
    const pkg = readPackageJson(current)
    if (pkg) {
      const framework = classifyPackageRoot(current, pkg)
      return {
        inputDir,
        launchDir: current,
        packageRoot: current,
        framework,
      }
    }

    const parent = path.dirname(current)
    if (parent === current) {
      return {
        inputDir,
        launchDir: inputDir,
        packageRoot: null,
        framework: 'unknown',
      }
    }
    current = parent
  }
}
