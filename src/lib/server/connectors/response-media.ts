import fs from 'fs'
import path from 'path'
import { UPLOAD_DIR } from '../storage'
import { safeJsonParseObject } from '../json-utils'
import type { InboundMessage, InboundMedia } from './types'

function resolveUploadPathFromUrl(rawUrl: string): string | null {
  if (!rawUrl) return null
  const normalized = rawUrl.trim()
  const match = normalized.match(/\/api\/uploads\/([^?#)\s]+)/)
  if (!match) return null
  let decoded: string
  try { decoded = decodeURIComponent(match[1]) } catch { decoded = match[1] }
  const safeName = decoded.replace(/[^a-zA-Z0-9._-]/g, '')
  if (!safeName) return null
  const filePath = path.join(UPLOAD_DIR, safeName)
  return fs.existsSync(filePath) ? filePath : null
}

export function uploadApiUrlFromPath(filePath: string): string | null {
  const rel = path.relative(UPLOAD_DIR, filePath)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  const fileName = path.basename(rel)
  return `/api/uploads/${encodeURIComponent(fileName)}`
}

export function parseSseDataEvents(raw: string): Array<Record<string, unknown>> {
  if (!raw) return []
  const events: Array<Record<string, unknown>> = []
  const lines = raw.split('\n')
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue
    const parsed = safeJsonParseObject(line.slice(6))
    if (parsed) events.push(parsed)
  }
  return events
}

export function parseConnectorToolResult(toolOutput: string): { status?: string; to?: string; followUpId?: string; messageId?: string } | null {
  const record = safeJsonParseObject(toolOutput)
  if (!record) return null
  const status = typeof record.status === 'string' ? String(record.status) : undefined
  const to = typeof record.to === 'string' ? String(record.to) : undefined
  const followUpId = typeof record.followUpId === 'string' ? String(record.followUpId) : undefined
  const messageId = typeof record.messageId === 'string' ? String(record.messageId) : undefined
  return { status, to, followUpId, messageId }
}

export function parseConnectorToolInput(toolInput: string): Record<string, unknown> | null {
  return safeJsonParseObject(toolInput)
}

export function visibleConnectorToolText(input: Record<string, unknown> | null): string {
  if (!input) return ''
  const voiceText = typeof input.voiceText === 'string' ? input.voiceText.trim() : ''
  if (voiceText) return voiceText
  const message = typeof input.message === 'string' ? input.message.trim() : ''
  if (message) return message
  const caption = typeof input.caption === 'string' ? input.caption.trim() : ''
  if (caption) return caption
  const text = typeof input.text === 'string' ? input.text.trim() : ''
  if (text) return text
  return ''
}

function canonicalUploadMediaKey(filePath: string): string {
  const base = path.basename(filePath)
  const ext = path.extname(base).toLowerCase()
  const normalized = base
    .replace(/^\d{10,16}-/, '')
    .replace(/^(?:browser|screenshot)-\d{10,16}(?:-\d+)?\./, 'playwright-capture.')
    .toLowerCase()
  return normalized || `unknown${ext}`
}

function shouldAllowMultipleMediaSends(userText: string): boolean {
  const text = (userText || '').toLowerCase()
  return /\b(all|both|multiple|several|many|every|each|two|three|4|four|screenshots|images|photos|files|documents)\b/.test(text)
}

function preferSingleBestMediaFile(files: Array<{ path: string; alt: string }>): Array<{ path: string; alt: string }> {
  if (files.length <= 1) return files
  const ranked = [...files].sort((a, b) => {
    const score = (entry: { path: string }) => {
      const base = path.basename(entry.path).toLowerCase()
      let value = 0
      if (/^\d{10,16}-/.test(base)) value += 20
      if (!base.startsWith('browser-') && !base.startsWith('screenshot-')) value += 10
      if (base.endsWith('.pdf')) value += 8
      if (base.endsWith('.png') || base.endsWith('.jpg') || base.endsWith('.jpeg') || base.endsWith('.webp')) value += 6
      try {
        const stat = fs.statSync(entry.path)
        value += Math.min(5, Math.round((stat.mtimeMs % 10_000) / 2_000))
      } catch { /* ignore stat errors */ }
      return value
    }
    return score(b) - score(a)
  })
  return [ranked[0]]
}

export function selectOutboundMediaFiles(
  files: Array<{ path: string; alt: string }>,
  userText: string,
): Array<{ path: string; alt: string }> {
  if (files.length === 0) return []
  const mergedFiles: Array<{ path: string; alt: string }> = []
  const seenMediaKeys = new Set<string>()
  for (const candidate of files) {
    const mediaKey = canonicalUploadMediaKey(candidate.path)
    if (seenMediaKeys.has(mediaKey)) continue
    seenMediaKeys.add(mediaKey)
    mergedFiles.push(candidate)
  }
  return shouldAllowMultipleMediaSends(userText || '')
    ? mergedFiles
    : preferSingleBestMediaFile(mergedFiles)
}

export function extractEmbeddedMedia(text: string): { cleanText: string; files: Array<{ path: string; alt: string }> } {
  const files: Array<{ path: string; alt: string }> = []
  const seen = new Set<string>()
  let cleanText = text

  const pushFile = (filePath: string, alt: string) => {
    if (!filePath || seen.has(filePath)) return
    seen.add(filePath)
    files.push({ path: filePath, alt: alt.trim() })
  }

  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g
  cleanText = cleanText.replace(imageRegex, (full, altRaw, urlRaw) => {
    const filePath = resolveUploadPathFromUrl(String(urlRaw || ''))
    if (!filePath) return full
    pushFile(filePath, String(altRaw || ''))
    return ''
  })

  const linkRegex = /(?<!!)\[([^\]]*)\]\(([^)]+)\)/g
  cleanText = cleanText.replace(linkRegex, (full, altRaw, urlRaw) => {
    const filePath = resolveUploadPathFromUrl(String(urlRaw || ''))
    if (!filePath) return full
    pushFile(filePath, String(altRaw || ''))
    return ''
  })

  const bareUploadUrlRegex = /(?:https?:\/\/[^\s)]+)?\/api\/uploads\/[^\s)\]]+/g
  cleanText = cleanText.replace(bareUploadUrlRegex, (full) => {
    const filePath = resolveUploadPathFromUrl(full)
    if (!filePath) return full
    pushFile(filePath, '')
    return ''
  })

  if (files.length === 0) return { cleanText: text, files }
  cleanText = cleanText.replace(/\n{3,}/g, '\n\n').trim()
  return { cleanText, files }
}

export function buildInboundAttachmentPaths(msg: InboundMessage): string[] {
  if (!Array.isArray(msg.media) || msg.media.length === 0) return []
  const paths: string[] = []
  const seen = new Set<string>()
  for (const media of msg.media) {
    const localPath = typeof media.localPath === 'string' ? media.localPath.trim() : ''
    if (!localPath || seen.has(localPath)) continue
    if (!fs.existsSync(localPath)) continue
    seen.add(localPath)
    paths.push(localPath)
  }
  return paths
}

/**
 * Normalize a phone number string to E.164 format (+<digits>).
 * Strips formatting characters, `whatsapp:` prefixes, and ensures a leading `+`.
 * Works for all country codes — no country-specific heuristics.
 */
export function normalizeE164(number: string): string {
  const withoutPrefix = number.replace(/^whatsapp:/i, '').trim()
  const digits = withoutPrefix.replace(/[^\d+]/g, '')
  if (digits.startsWith('+')) return `+${digits.slice(1)}`
  return `+${digits}`
}

const WHATSAPP_USER_JID_RE = /^(\d+)(?::\d+)?@s\.whatsapp\.net$/i
const WHATSAPP_LID_RE = /^(\d+)(?::\d+)?@lid$/i
const WHATSAPP_GROUP_JID_RE = /^[\d]+(-[\d]+)*@g\.us$/i

/**
 * Normalize a WhatsApp target (phone number, user JID, group JID) into
 * a canonical JID suitable for sending messages.
 *
 * - Group JIDs (`…@g.us`) are preserved as-is.
 * - User JIDs (`…@s.whatsapp.net`, `…@lid`) extract the phone number.
 * - Plain phone numbers are cleaned to digits and suffixed with `@s.whatsapp.net`.
 *
 * Works for all country codes.
 */
export function normalizeWhatsappTarget(raw: string): string {
  const trimmed = raw.replace(/^whatsapp:/i, '').trim()
  if (!trimmed) return trimmed

  // Group JIDs — preserve as-is
  if (WHATSAPP_GROUP_JID_RE.test(trimmed)) return trimmed

  // User JIDs — extract the phone number digits
  const userMatch = trimmed.match(WHATSAPP_USER_JID_RE)
  if (userMatch) return `${userMatch[1]}@s.whatsapp.net`

  const lidMatch = trimmed.match(WHATSAPP_LID_RE)
  if (lidMatch) return trimmed // LID JIDs can't be converted to phone-based JIDs

  // Unknown JID format — return as-is to avoid mangling
  if (trimmed.includes('@')) return trimmed

  // Plain phone number — strip to digits and build JID
  const digits = trimmed.replace(/[^\d+]/g, '')
  const cleaned = digits.startsWith('+') ? digits.slice(1) : digits
  return cleaned ? `${cleaned}@s.whatsapp.net` : trimmed
}

export function connectorSupportsBinaryMedia(platform: string): boolean {
  return platform === 'whatsapp'
    || platform === 'telegram'
    || platform === 'slack'
    || platform === 'discord'
    || platform === 'openclaw'
}

export function formatMediaLine(media: InboundMedia): string {
  const typeLabel = media.type.toUpperCase()
  const name = media.fileName || media.mimeType || 'attachment'
  const size = media.sizeBytes ? ` (${Math.max(1, Math.round(media.sizeBytes / 1024))} KB)` : ''
  if (media.url) return `- ${typeLabel}: ${name}${size} -> ${media.url}`
  return `- ${typeLabel}: ${name}${size}`
}

export function formatInboundUserText(msg: InboundMessage): string {
  const baseText = (msg.text || '').trim()
  const lines: string[] = []
  if (baseText) lines.push(`[${msg.senderName}] ${baseText}`)
  else lines.push(`[${msg.senderName}]`)

  if (Array.isArray(msg.media) && msg.media.length > 0) {
    lines.push('')
    lines.push('Media received:')
    const preview = msg.media.slice(0, 6)
    for (const media of preview) lines.push(formatMediaLine(media))
    if (msg.media.length > preview.length) {
      lines.push(`- ...and ${msg.media.length - preview.length} more attachment(s)`)
    }
  }

  return lines.join('\n').trim()
}
