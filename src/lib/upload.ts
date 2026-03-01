import type { UploadResult } from '../types'
import { getStoredAccessKey } from './api-client'

export async function uploadImage(file: File): Promise<UploadResult> {
  const key = getStoredAccessKey()
  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: {
      'X-Filename': file.name,
      ...(key ? { 'X-Access-Key': key } : {}),
    },
    body: file,
  })
  if (!res.ok) throw new Error(`Upload failed (${res.status})`)
  return res.json()
}
