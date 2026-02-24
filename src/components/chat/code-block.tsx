'use client'

import { useCallback, useState, type ReactNode } from 'react'

function extractText(node: ReactNode): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (!node) return ''
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (typeof node === 'object' && 'props' in node) {
    return extractText((node as any).props.children)
  }
  return ''
}

interface Props {
  children: ReactNode
  className?: string
}

const PREVIEWABLE = new Set(['html', 'htm', 'svg'])

export function CodeBlock({ children, className }: Props) {
  const [copied, setCopied] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const language = className?.replace(/hljs\s*/g, '').replace(/language-/g, '').trim() || ''
  const canPreview = PREVIEWABLE.has(language)

  const getText = useCallback(() => extractText(children), [children])

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(getText()).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [getText])

  const handlePreview = useCallback(() => {
    setPreviewing((v) => !v)
  }, [])

  const handleOpenTab = useCallback(() => {
    const text = getText()
    const blob = new Blob([text], { type: language === 'svg' ? 'image/svg+xml' : 'text/html' })
    window.open(URL.createObjectURL(blob), '_blank')
  }, [getText, language])

  const handleSave = useCallback(() => {
    const text = getText()
    const ext = language || 'txt'
    const blob = new Blob([text], { type: 'text/plain' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `code.${ext}`
    a.click()
  }, [getText, language])

  return (
    <div className="relative group/code">
      <div className="flex items-center justify-between px-4 py-2 bg-black/30 border-b border-white/[0.03]">
        <span className="text-[10px] font-600 uppercase tracking-[0.08em] text-text-3 font-mono">{language}</span>
        <div className="flex items-center gap-1">
          {canPreview && (
            <>
              <button
                onClick={handlePreview}
                className={`flex items-center gap-1.5 text-[10px] font-600 bg-transparent border-none cursor-pointer
                  transition-all duration-200 px-2 py-0.5 rounded-[6px]
                  ${previewing ? 'text-accent-bright' : 'text-text-3/50 hover:text-text-2 hover:bg-white/[0.04]'}`}
                style={{ fontFamily: 'inherit' }}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
                {previewing ? 'Code' : 'Preview'}
              </button>
              <button
                onClick={handleOpenTab}
                className="flex items-center gap-1.5 text-[10px] font-600 bg-transparent border-none cursor-pointer
                  transition-all duration-200 px-2 py-0.5 rounded-[6px] text-text-3/50 hover:text-text-2 hover:bg-white/[0.04]"
                style={{ fontFamily: 'inherit' }}
                title="Open in new tab"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
                Open
              </button>
            </>
          )}
          <button
            onClick={handleSave}
            className="flex items-center gap-1.5 text-[10px] font-600 bg-transparent border-none cursor-pointer
              transition-all duration-200 px-2 py-0.5 rounded-[6px] text-text-3/50 hover:text-text-2 hover:bg-white/[0.04]"
            style={{ fontFamily: 'inherit' }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Save
          </button>
          <button
            onClick={handleCopy}
            className={`flex items-center gap-1.5 text-[10px] font-600 bg-transparent border-none cursor-pointer
              transition-all duration-200 px-2 py-0.5 rounded-[6px]
              ${copied
                ? 'text-success'
                : 'text-text-3/50 hover:text-text-2 hover:bg-white/[0.04]'}`}
            style={{ fontFamily: 'inherit' }}
          >
            {copied ? (
              <>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12" /></svg>
                Copied
              </>
            ) : (
              <>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                Copy
              </>
            )}
          </button>
        </div>
      </div>
      {canPreview && previewing ? (
        <iframe
          srcDoc={getText()}
          sandbox="allow-scripts"
          className="w-full border-none bg-white rounded-b-[8px]"
          style={{ minHeight: 300, maxHeight: 600 }}
          title="Code preview"
        />
      ) : (
        <code className={className}>{children}</code>
      )}
    </div>
  )
}
