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

export function CodeBlock({ children, className }: Props) {
  const [copied, setCopied] = useState(false)
  const language = className?.replace(/hljs\s*/g, '').replace(/language-/g, '').trim() || ''

  const handleCopy = useCallback(() => {
    const text = extractText(children)
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [children])

  return (
    <div className="relative group/code">
      <div className="flex items-center justify-between px-4 py-2 bg-black/30 border-b border-white/[0.03]">
        <span className="text-[10px] font-600 uppercase tracking-[0.08em] text-text-3 font-mono">{language}</span>
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
      <code className={className}>{children}</code>
    </div>
  )
}
