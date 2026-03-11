import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface SandboxFsMount {
  hostRoot: string
  containerRoot: string
  writable: boolean
  source: 'workspace' | 'uploads' | 'bind'
}

export interface SandboxResolvedFsPath {
  hostPath: string
  containerPath: string
  relativePath: string
  writable: boolean
}

export interface SandboxFsBridge {
  mounts: SandboxFsMount[]
  resolvePath(params: { filePath: string; cwd?: string }): SandboxResolvedFsPath
}

function normalizeInputPath(value: string): string {
  return value.trim().replace(/^sandbox:/, '').replace(/\\/g, '/')
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  if (!relative) return true
  return !(relative.startsWith('..') || path.isAbsolute(relative))
}

function toPosixRelative(from: string, target: string): string {
  const relative = path.relative(from, target)
  if (!relative) return ''
  return relative.split(path.sep).join(path.posix.sep)
}

function resolveMountByHost(mounts: SandboxFsMount[], hostPath: string): SandboxFsMount | null {
  const ordered = [...mounts].sort((left, right) => right.hostRoot.length - left.hostRoot.length)
  return ordered.find((mount) => isPathInside(mount.hostRoot, hostPath)) || null
}

function resolveMountByContainer(mounts: SandboxFsMount[], containerPath: string): SandboxFsMount | null {
  const ordered = [...mounts].sort((left, right) => right.containerRoot.length - left.containerRoot.length)
  return ordered.find((mount) => {
    const relative = path.posix.relative(mount.containerRoot, containerPath)
    return !relative || (!relative.startsWith('..') && !path.posix.isAbsolute(relative))
  }) || null
}

function coercePathInput(filePath: string, cwd: string): string {
  const normalized = normalizeInputPath(filePath)
  if (!normalized) return cwd
  if (/^file:/i.test(normalized)) {
    try {
      return fileURLToPath(normalized)
    } catch {
      return normalized
    }
  }
  if (path.posix.isAbsolute(normalized)) {
    return normalized
  }
  return path.resolve(cwd, normalized)
}

export function createSandboxFsBridge(params: {
  workspaceDir: string
  containerWorkdir: string
  workspaceAccess: 'ro' | 'rw'
  extraMounts?: SandboxFsMount[]
}): SandboxFsBridge {
  const workspaceDir = path.resolve(params.workspaceDir)
  const mounts: SandboxFsMount[] = [
    {
      hostRoot: workspaceDir,
      containerRoot: params.containerWorkdir,
      writable: params.workspaceAccess === 'rw',
      source: 'workspace',
    },
    ...(params.extraMounts || []).map((mount) => ({
      ...mount,
      hostRoot: path.resolve(mount.hostRoot),
    })),
  ]

  return {
    mounts,
    resolvePath({ filePath, cwd }) {
      const resolvedCwd = path.resolve(cwd || workspaceDir)
      const rawInput = coercePathInput(filePath, resolvedCwd)

      if (path.posix.isAbsolute(rawInput) && rawInput.includes('/')) {
        const containerMount = resolveMountByContainer(mounts, rawInput)
        if (containerMount) {
          const relative = path.posix.relative(containerMount.containerRoot, rawInput)
          const hostPath = relative
            ? path.resolve(containerMount.hostRoot, ...relative.split('/').filter(Boolean))
            : containerMount.hostRoot
          return {
            hostPath,
            containerPath: relative
              ? path.posix.join(containerMount.containerRoot, relative)
              : containerMount.containerRoot,
            relativePath: relative,
            writable: containerMount.writable,
          }
        }
      }

      const hostPath = path.isAbsolute(rawInput) ? path.resolve(rawInput) : path.resolve(resolvedCwd, rawInput)
      const mount = resolveMountByHost(mounts, hostPath)
      if (!mount) {
        throw new Error(`Path escapes sandbox mounts: ${filePath}`)
      }
      const relative = toPosixRelative(mount.hostRoot, hostPath)
      return {
        hostPath,
        containerPath: relative
          ? path.posix.join(mount.containerRoot, relative)
          : mount.containerRoot,
        relativePath: relative,
        writable: mount.writable,
      }
    },
  }
}
