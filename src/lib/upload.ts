import type { UploadResult } from '../types'

export async function uploadImage(file: File): Promise<UploadResult> {
  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: { 'X-Filename': file.name },
    body: file,
  })
  return res.json()
}
