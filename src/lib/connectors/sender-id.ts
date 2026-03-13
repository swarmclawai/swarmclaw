export function normalizeSenderId(value: string): string {
  return value.trim().toLowerCase()
}

export function senderIdVariants(value: string): string[] {
  const normalized = normalizeSenderId(value)
  if (!normalized) return []

  const variants = new Set<string>([normalized])
  const jidUser = normalized.split('@')[0]?.split(':')[0]?.trim()
  if (jidUser) variants.add(jidUser)

  const digits = normalized.replace(/[^\d]/g, '')
  if (digits) {
    variants.add(digits)
    variants.add(`${digits}@s.whatsapp.net`)
  }

  return [...variants]
}

export function senderMatchesAnyEntry(senderIds: string | string[], entries: string[]): boolean {
  const ids = Array.isArray(senderIds) ? senderIds : [senderIds]
  const variants = new Set(ids.flatMap((value) => senderIdVariants(value)))
  if (variants.size === 0) return false
  return entries.some((entry) => senderIdVariants(entry).some((variant) => variants.has(variant)))
}

export function findMatchingSenderEntry(entries: string[], senderIds: string | string[]): string | null {
  return entries.find((entry) => senderMatchesAnyEntry(senderIds, [entry])) || null
}
