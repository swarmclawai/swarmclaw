export const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'])
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.avi', '.mkv'])
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg'])
const DOCUMENT_EXTS = new Set(['.pdf', '.json', '.csv', '.txt', '.html', '.xml', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'])
const ARCHIVE_EXTS = new Set(['.zip', '.tar', '.gz'])

export type FileCategory = 'image' | 'video' | 'audio' | 'document' | 'archive' | 'other'

export function getFileCategory(ext: string): FileCategory {
  const lower = ext.toLowerCase()
  if (IMAGE_EXTS.has(lower)) return 'image'
  if (VIDEO_EXTS.has(lower)) return 'video'
  if (AUDIO_EXTS.has(lower)) return 'audio'
  if (DOCUMENT_EXTS.has(lower)) return 'document'
  if (ARCHIVE_EXTS.has(lower)) return 'archive'
  return 'other'
}
