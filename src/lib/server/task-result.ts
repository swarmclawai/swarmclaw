import { z } from 'zod'

// ---------------------------------------------------------------------------
// Zod schemas for structured task result extraction
// ---------------------------------------------------------------------------

export const ArtifactSchema = z.object({
  url: z.string(),
  type: z.enum(['image', 'video', 'pdf', 'file']),
  filename: z.string(),
})

export const TaskResultSchema = z.object({
  summary: z.string(),
  artifacts: z.array(ArtifactSchema),
})

export type Artifact = z.infer<typeof ArtifactSchema>
export type TaskResult = z.infer<typeof TaskResultSchema>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SANDBOX_RE = /^sandbox:/
const UPLOAD_URL_RE = /(?:sandbox:)?\/api\/uploads\/[^\s)"'>\]]+/gi

function stripSandbox(url: string): string {
  return url.replace(SANDBOX_RE, '')
}

function classifyArtifact(filename: string): Artifact['type'] {
  if (/\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(filename)) return 'image'
  if (/\.(mp4|webm|mov|avi)$/i.test(filename)) return 'video'
  if (/\.pdf$/i.test(filename)) return 'pdf'
  return 'file'
}

// ---------------------------------------------------------------------------
// Session message types (loose to avoid coupling to full types)
// ---------------------------------------------------------------------------

interface MessageLike {
  role?: string
  text?: string
  imageUrl?: string
  imagePath?: string
  toolEvents?: Array<{ name?: string; output?: string }>
}

interface SessionLike {
  messages?: MessageLike[]
}

// ---------------------------------------------------------------------------
// Core extraction
// ---------------------------------------------------------------------------

/**
 * Walk a session's messages and extract all artifacts + a clean summary.
 * Replaces the old regex-based `extractLatestUploadUrl` and
 * `summarizeScheduleTaskResult` with a single Zod-validated pass.
 */
export function extractTaskResult(
  session: SessionLike | null | undefined,
  rawResultText: string | null | undefined,
): TaskResult {
  const seen = new Set<string>()
  const artifacts: Artifact[] = []

  function addUrl(raw: string) {
    const url = stripSandbox(raw)
    if (seen.has(url)) return
    seen.add(url)
    const filename = url.split('/').pop()?.split('?')[0] || 'file'
    artifacts.push({ url, type: classifyArtifact(filename), filename })
  }

  // Walk session messages to collect all artifact URLs
  if (Array.isArray(session?.messages)) {
    for (const msg of session.messages) {
      // Explicit image fields
      if (msg.imageUrl) addUrl(msg.imageUrl)
      if (msg.imagePath) {
        const basename = String(msg.imagePath).split('/').pop()
        if (basename) addUrl(`/api/uploads/${basename}`)
      }

      // Scan message text
      const text = typeof msg.text === 'string' ? msg.text : ''
      for (const m of text.matchAll(UPLOAD_URL_RE)) addUrl(m[0])

      // Scan tool event outputs
      if (Array.isArray(msg.toolEvents)) {
        for (const ev of msg.toolEvents) {
          const output = typeof ev.output === 'string' ? ev.output : ''
          for (const m of output.matchAll(UPLOAD_URL_RE)) addUrl(m[0])
        }
      }
    }
  }

  // Clean summary: strip sandbox: prefixes from the raw text
  const summary = (typeof rawResultText === 'string' ? rawResultText.trim() : '')
    .replace(/sandbox:\/api\/uploads\//g, '/api/uploads/')

  return TaskResultSchema.parse({ summary, artifacts })
}

// ---------------------------------------------------------------------------
// Formatting helpers for thread / main-chat messages
// ---------------------------------------------------------------------------

/**
 * Build the markdown body for a task result notification.
 * Uses the same markdown patterns the chat bubble renderer already handles:
 *   - `![alt](url)` for images and videos → rendered as <img> / <video>
 *   - `[filename](url)` for PDFs and other files → rendered as download link
 */
export function formatResultBody(result: TaskResult): string {
  const parts: string[] = []

  if (result.summary) {
    // Remove any existing markdown image/link references to artifacts
    // we'll re-add them properly below
    let clean = result.summary
    for (const a of result.artifacts) {
      // Remove ![...](url) and [...](url) patterns for this artifact
      clean = clean
        .replace(new RegExp(`!\\[[^\\]]*\\]\\(${escapeRegex(a.url)}\\)`, 'g'), '')
        .replace(new RegExp(`\\[[^\\]]*\\]\\(${escapeRegex(a.url)}\\)`, 'g'), '')
    }
    clean = clean.replace(/\n{3,}/g, '\n\n').trim()
    if (clean) parts.push(clean)
  }

  // Add artifacts with proper markdown for each type
  for (const artifact of result.artifacts) {
    switch (artifact.type) {
      case 'image':
        parts.push(`![${artifact.filename}](${artifact.url})`)
        break
      case 'video':
        // Markdown img with video extension → chat renderer uses <video>
        parts.push(`![${artifact.filename}](${artifact.url})`)
        break
      case 'pdf':
        parts.push(`[${artifact.filename}](${artifact.url})`)
        break
      case 'file':
        parts.push(`[${artifact.filename}](${artifact.url})`)
        break
    }
  }

  return parts.join('\n\n')
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
