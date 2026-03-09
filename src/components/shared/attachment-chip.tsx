'use client'

import { useState } from 'react'
import { CodeBlock } from '@/components/chat/code-block'

export const IMAGE_ATTACH_RE = /\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)$/i
export const PREVIEWABLE_ATTACH_RE = /\.(html?|svg)$/i
export const CODE_ATTACH_RE = /\.(js|jsx|ts|tsx|css|json|md|txt|py|sh|rb|go|rs|c|cpp|h|java|yaml|yml|toml|xml|sql|graphql)$/i
export const PDF_ATTACH_RE = /\.pdf$/i
export const FILE_TYPE_COLORS: Record<string, string> = {
  html: 'text-orange-400', htm: 'text-orange-400', svg: 'text-emerald-400',
  js: 'text-yellow-400', jsx: 'text-yellow-400', ts: 'text-blue-400', tsx: 'text-blue-400',
  py: 'text-green-400', json: 'text-amber-300', css: 'text-purple-400', scss: 'text-pink-400',
  md: 'text-text-2', txt: 'text-text-3', pdf: 'text-red-400',
}

export function parseAttachmentUrl(filePath?: string, fileUrl?: string) {
  const url = fileUrl || (filePath ? `/api/uploads/${filePath.split('/').pop()}` : '')
  const rawName = filePath?.split('/').pop() || fileUrl?.split('/').pop() || 'file'
  const filename = rawName.replace(/^[a-f0-9]+-/, '').split('?')[0]
  return { url, filename }
}

export function AttachmentChip({
  url,
  filename,
  isUserMsg,
  onOpenImage,
}: {
  url: string
  filename: string
  isUserMsg?: boolean
  onOpenImage?: (image: { url: string; filename: string }) => void
}) {
  const isImage = IMAGE_ATTACH_RE.test(filename)
  const isCode = CODE_ATTACH_RE.test(filename)
  const isPdf = PDF_ATTACH_RE.test(filename)
  const [lightbox, setLightbox] = useState(false)
  const [codePreview, setCodePreview] = useState<string | null>(null)
  const [codeExpanded, setCodeExpanded] = useState(false)

  if (isImage) {
    return (
      <>
        <img
          src={url} alt="Attached"
          loading="lazy"
          className="max-w-[240px] rounded-[12px] mb-2 border border-white/10 cursor-pointer hover:border-white/25 transition-colors"
          onClick={() => {
            if (onOpenImage) {
              onOpenImage({ url, filename })
              return
            }
            setLightbox(true)
          }}
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
        />
        {!onOpenImage && lightbox && (
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm cursor-pointer"
            onClick={() => setLightbox(false)}
          >
            <img src={url} alt="Preview" className="max-w-[90vw] max-h-[90vh] rounded-[12px] shadow-2xl" />
          </div>
        )}
      </>
    )
  }

  if (isPdf) {
    return (
      <div className="mb-2 rounded-[12px] border border-white/[0.08] bg-[rgba(255,255,255,0.02)] overflow-hidden" style={{ maxWidth: 480 }}>
        <div className="flex items-center gap-3 px-4 py-2.5">
          <div className="flex items-center justify-center w-8 h-8 rounded-[8px] shrink-0 bg-red-500/10 text-red-400">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
          </div>
          <span className="text-[13px] font-500 truncate flex-1">{filename}</span>
          <a href={url} download={filename} className="text-[11px] font-600 text-text-3 hover:text-text-2 no-underline">Download</a>
        </div>
        <iframe src={url} loading="lazy" className="w-full h-[300px] border-t border-white/[0.06]" title={filename} />
      </div>
    )
  }

  const ext = filename.split('.').pop()?.toLowerCase() || ''
  const colorClass = FILE_TYPE_COLORS[ext] || 'text-text-3'
  const isPreviewable = PREVIEWABLE_ATTACH_RE.test(filename)

  const chipBg = isUserMsg
    ? 'bg-[rgba(0,0,0,0.25)] border-white/[0.12]'
    : 'bg-[rgba(255,255,255,0.04)] border-white/[0.08]'
  const iconBg = isUserMsg ? 'bg-white/[0.12]' : 'bg-white/[0.05]'
  const btnBg = isUserMsg
    ? 'bg-white/[0.12] hover:bg-white/[0.18] text-white/80'
    : 'bg-white/[0.06] hover:bg-white/[0.10] text-text-3'

  const handleCodePreview = async () => {
    if (codePreview !== null) { setCodeExpanded(!codeExpanded); return }
    try {
      const serveUrl = `/api/files/serve?path=${encodeURIComponent(url.replace('/api/uploads/', ''))}`
      const res = await fetch(url.startsWith('/api/files/') ? url : serveUrl)
      if (!res.ok) return
      const text = await res.text()
      setCodePreview(text)
      setCodeExpanded(true)
    } catch {
      // ignore
    }
  }

  return (
    <div className="mb-2">
      <div className={`flex items-center gap-3 px-4 py-2.5 rounded-[12px] border ${chipBg}`}>
        <div className={`flex items-center justify-center w-8 h-8 rounded-[8px] shrink-0 ${iconBg} ${colorClass}`}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
        </div>
        <div className="flex flex-col flex-1 min-w-0">
          <span className={`text-[13px] font-500 truncate ${isUserMsg ? 'text-white' : 'text-text'}`}>{filename}</span>
          <span className={`text-[11px] uppercase tracking-wide ${isUserMsg ? 'text-white/50' : 'text-text-3/70'}`}>{ext || 'file'}</span>
        </div>
        {isCode && (
          <button
            onClick={handleCodePreview}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-[8px] text-[11px] font-600 no-underline transition-colors shrink-0 border-none cursor-pointer ${
              isUserMsg ? 'bg-white/[0.15] hover:bg-white/[0.22] text-white' : 'bg-accent-soft hover:bg-accent-soft/80 text-accent-bright'
            }`}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <polyline points="16 18 22 12 16 6" />
              <polyline points="8 6 2 12 8 18" />
            </svg>
            {codeExpanded ? 'Hide' : 'Preview'}
          </button>
        )}
        {isPreviewable && (
          <a href={url} target="_blank" rel="noopener noreferrer"
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-[8px] text-[11px] font-600 no-underline transition-colors shrink-0 ${
              isUserMsg ? 'bg-white/[0.15] hover:bg-white/[0.22] text-white' : 'bg-accent-soft hover:bg-accent-soft/80 text-accent-bright'
            }`}
            title="Preview in new tab">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            Preview
          </a>
        )}
        <a href={url} download={filename}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-[8px] text-[11px] font-600 no-underline transition-colors shrink-0 ${btnBg}`}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          Download
        </a>
      </div>
      {isCode && codeExpanded && codePreview !== null && (
        <div className="mt-1 rounded-[10px] border border-white/[0.06] overflow-hidden" style={{ animation: 'fade-in 0.2s ease' }}>
          <CodeBlock className={`language-${ext}`}>
            {codePreview.split('\n').slice(0, codeExpanded ? undefined : 10).join('\n')}
          </CodeBlock>
          {codePreview.split('\n').length > 10 && (
            <button
              onClick={() => setCodeExpanded((v) => !v)}
              className="w-full px-3 py-1.5 text-[10px] text-text-3 hover:text-text-2 bg-white/[0.02] hover:bg-white/[0.04] border-none border-t border-white/[0.06] cursor-pointer transition-colors"
            >
              {codePreview.split('\n').length > 10 ? `Show all ${codePreview.split('\n').length} lines` : 'Show less'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
