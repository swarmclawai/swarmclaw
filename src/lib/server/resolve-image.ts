import fs from 'fs'
import path from 'path'
import { UPLOAD_DIR } from './storage'

const UPLOAD_URL_PREFIX = '/api/uploads/'

/**
 * Resolve an image to a valid filesystem path.
 *
 * Tries, in order:
 *   1. `imagePath` (the absolute filesystem path returned by the upload API)
 *   2. `imageUrl` mapped back to the uploads dir (e.g. `/api/uploads/foo.jpeg` → `UPLOAD_DIR/foo.jpeg`)
 *
 * Returns `null` if neither resolves to an existing file.
 */
export function resolveImagePath(imagePath?: string, imageUrl?: string): string | null {
  if (imagePath && fs.existsSync(imagePath)) return imagePath

  // Fall back: resolve relative API URL to filesystem
  if (imageUrl?.startsWith(UPLOAD_URL_PREFIX)) {
    const filename = imageUrl.slice(UPLOAD_URL_PREFIX.length)
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '')
    if (safeName) {
      const resolved = path.join(UPLOAD_DIR, safeName)
      if (fs.existsSync(resolved)) return resolved
    }
  }

  return null
}
