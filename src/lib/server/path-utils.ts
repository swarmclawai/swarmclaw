import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

function normalizeBaseDir(baseDir: string): string {
  const normalized = path.normalize(baseDir)
  if (!normalized) return path.sep
  return normalized
}

function baseDirPrefix(baseDir: string): string {
  const normalized = normalizeBaseDir(baseDir)
  return normalized.endsWith(path.sep) ? normalized : `${normalized}${path.sep}`
}

export function resolvePathWithinBaseDir(baseDir: string, targetPath: string): string {
  const normalizedBase = normalizeBaseDir(baseDir)
  const baseUrl = pathToFileURL(baseDirPrefix(normalizedBase))
  const resolved = path.normalize(fileURLToPath(new URL(targetPath.replace(/\\/g, '/'), baseUrl)))
  if (resolved !== normalizedBase && !resolved.startsWith(baseDirPrefix(normalizedBase))) {
    throw new Error('Path traversal not allowed')
  }
  return resolved
}

export function tryResolvePathWithinBaseDir(baseDir: string, targetPath: string): string | null {
  try {
    return resolvePathWithinBaseDir(baseDir, targetPath)
  } catch {
    return null
  }
}
