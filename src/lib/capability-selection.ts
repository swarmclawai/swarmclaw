import { dedup } from '@/lib/shared-utils'

const EXTENSION_FILENAME_RE = /\.(?:m?js)$/i

function normalizeList(values: string[] | null | undefined): string[] {
  if (!Array.isArray(values)) return []
  return dedup(
    values
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean),
  )
}

export function isExternalExtensionId(value: unknown): boolean {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return Boolean(normalized) && EXTENSION_FILENAME_RE.test(normalized)
}

export function splitCapabilityIds(values: string[] | null | undefined): {
  tools: string[]
  extensions: string[]
} {
  const tools: string[] = []
  const extensions: string[] = []

  for (const value of normalizeList(values)) {
    if (isExternalExtensionId(value)) extensions.push(value)
    else tools.push(value)
  }

  return {
    tools: dedup(tools),
    extensions: dedup(extensions),
  }
}

export function mergeCapabilityIds(
  tools: string[] | null | undefined,
  extensions: string[] | null | undefined,
): string[] {
  return dedup([...normalizeList(tools), ...normalizeList(extensions)])
}

export function normalizeCapabilitySelection(input: {
  tools?: string[] | null
  extensions?: string[] | null
}): {
  tools: string[]
  extensions: string[]
} {
  return {
    tools: normalizeList(input.tools),
    extensions: normalizeList(input.extensions),
  }
}

export function getEnabledCapabilitySelection(entity: {
  tools?: string[] | null
  extensions?: string[] | null
} | null | undefined): {
  tools: string[]
  extensions: string[]
} {
  return normalizeCapabilitySelection({
    tools: entity?.tools,
    extensions: entity?.extensions,
  })
}

export function getEnabledToolIds(entity: {
  tools?: string[] | null
} | null | undefined): string[] {
  return normalizeCapabilitySelection({
    tools: entity?.tools,
  }).tools
}

export function getEnabledExtensionIds(entity: {
  extensions?: string[] | null
} | null | undefined): string[] {
  return normalizeCapabilitySelection({
    extensions: entity?.extensions,
  }).extensions
}

export function getEnabledCapabilityIds(entity: {
  tools?: string[] | null
  extensions?: string[] | null
} | null | undefined): string[] {
  return mergeCapabilityIds(entity?.tools, entity?.extensions)
}
