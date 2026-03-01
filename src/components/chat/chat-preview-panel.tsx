'use client'

import { useCallback, useRef, useState } from 'react'
import { CodeBlock } from './code-block'

interface PreviewContent {
  type: 'browser' | 'image' | 'code' | 'html'
  url?: string
  content?: string
  title?: string
}

interface Props {
  content: PreviewContent
  onClose: () => void
}

export function ChatPreviewPanel({ content, onClose }: Props) {
  const [width, setWidth] = useState(400)
  const dragging = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(400)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    startX.current = e.clientX
    startWidth.current = width

    const handleMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      const diff = startX.current - ev.clientX
      const next = Math.max(300, Math.min(window.innerWidth * 0.5, startWidth.current + diff))
      setWidth(next)
    }

    const handleMouseUp = () => {
      dragging.current = false
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [width])

  return (
    <div
      className="flex flex-col border-l border-white/[0.06] bg-bg shrink-0"
      style={{ width, minWidth: 300, maxWidth: '50%', animation: 'fade-in 0.25s ease' }}
    >
      {/* Resize handle */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-accent-bright/20 transition-colors z-10"
        style={{ position: 'relative', width: 4, minWidth: 4 }}
        onMouseDown={handleMouseDown}
      />

      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-white/[0.06] shrink-0">
        <span className="text-[12px] font-600 text-text-2 truncate flex-1">
          {content.title || 'Preview'}
        </span>
        <button
          onClick={onClose}
          className="p-1 rounded-[6px] text-text-3 hover:text-text-2 hover:bg-white/[0.04] cursor-pointer border-none bg-transparent transition-colors"
          aria-label="Close preview"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto min-h-0">
        {content.type === 'browser' && content.url && (
          <iframe
            src={content.url}
            className="w-full h-full border-none"
            title={content.title || 'Browser Preview'}
            sandbox="allow-scripts allow-same-origin"
          />
        )}
        {content.type === 'html' && content.content && (
          <iframe
            srcDoc={content.content}
            className="w-full h-full border-none"
            title={content.title || 'HTML Preview'}
            sandbox="allow-scripts"
          />
        )}
        {content.type === 'image' && content.url && (
          <div className="p-4 flex items-center justify-center h-full">
            <img
              src={content.url}
              alt={content.title || 'Preview'}
              className="max-w-full max-h-full rounded-[8px] object-contain"
            />
          </div>
        )}
        {content.type === 'code' && content.content && (
          <div className="p-2">
            <CodeBlock className={`language-${content.title?.split('.').pop() || 'text'}`}>
              {content.content}
            </CodeBlock>
          </div>
        )}
      </div>
    </div>
  )
}
