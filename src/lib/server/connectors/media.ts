import fs from 'fs'
import path from 'path'
import { genId } from '@/lib/id'
import { UPLOAD_DIR } from '../storage'
import type { InboundMedia, InboundMediaType } from './types'

const MIME_EXT_MAP: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'application/pdf': '.pdf',
}

function normalizeExt(ext: string): string {
  const trimmed = ext.trim().toLowerCase().replace(/[^a-z0-9.]/g, '')
  if (!trimmed) return ''
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`
}

function extFromName(fileName?: string): string {
  if (!fileName) return ''
  return normalizeExt(path.extname(fileName))
}

function extFromMime(mimeType?: string): string {
  if (!mimeType) return ''
  const key = mimeType.toLowerCase().split(';')[0].trim()
  return MIME_EXT_MAP[key] || ''
}

function safeBaseName(fileName?: string): string {
  if (!fileName) return 'attachment'
  const base = path.basename(fileName, path.extname(fileName))
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^_+|_+$/g, '')
  return cleaned || 'attachment'
}

function ensureUploadDir() {
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })
}

const EXT_MIME_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_EXT_MAP).map(([m, e]) => [e, m])
)
// Add extras not covered by reverse map
Object.assign(EXT_MIME_MAP, {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
})

/** Guess MIME type from file extension */
export function mimeFromPath(filePath: string): string {
  const ext = normalizeExt(path.extname(filePath))
  return EXT_MIME_MAP[ext] || 'application/octet-stream'
}

/** Check if a MIME type is an image */
export function isImageMime(mime: string): boolean {
  return mime.startsWith('image/')
}

export function inferInboundMediaType(mimeType?: string, fileName?: string, fallback: InboundMediaType = 'file'): InboundMediaType {
  const probe = `${mimeType || ''} ${fileName || ''}`.toLowerCase()
  if (probe.includes('image')) return 'image'
  if (probe.includes('video')) return 'video'
  if (probe.includes('audio') || probe.includes('voice')) return 'audio'
  if (probe.includes('pdf') || probe.includes('doc') || probe.includes('sheet') || probe.includes('ppt') || probe.includes('text')) return 'document'
  return fallback
}

export function saveInboundMediaBuffer(params: {
  connectorId: string
  buffer: Buffer
  mediaType: InboundMediaType
  mimeType?: string
  fileName?: string
}): InboundMedia {
  ensureUploadDir()

  const ext = extFromName(params.fileName) || extFromMime(params.mimeType) || '.bin'
  const base = safeBaseName(params.fileName)
  const unique = genId()
  const filename = `${params.connectorId}-${Date.now()}-${base}-${unique}${ext}`
  const localPath = path.join(UPLOAD_DIR, filename)
  fs.writeFileSync(localPath, params.buffer)

  return {
    type: params.mediaType,
    fileName: params.fileName || filename,
    mimeType: params.mimeType,
    sizeBytes: params.buffer.length,
    localPath,
    url: `/api/uploads/${filename}`,
  }
}

export async function downloadInboundMediaToUpload(params: {
  connectorId: string
  mediaType: InboundMediaType
  url: string
  headers?: Record<string, string>
  fileName?: string
  mimeType?: string
  maxBytes?: number
}): Promise<InboundMedia | null> {
  const res = await fetch(params.url, {
    headers: params.headers,
    redirect: 'follow',
  })
  if (!res.ok) {
    throw new Error(`Media download failed (${res.status})`)
  }

  const arrayBuffer = await res.arrayBuffer()
  const buf = Buffer.from(arrayBuffer)
  const maxBytes = params.maxBytes ?? 30 * 1024 * 1024
  if (buf.length > maxBytes) {
    return {
      type: params.mediaType,
      fileName: params.fileName,
      mimeType: params.mimeType || res.headers.get('content-type') || undefined,
      sizeBytes: buf.length,
      url: params.url,
    }
  }

  return saveInboundMediaBuffer({
    connectorId: params.connectorId,
    buffer: buf,
    mediaType: params.mediaType,
    mimeType: params.mimeType || res.headers.get('content-type') || undefined,
    fileName: params.fileName,
  })
}
