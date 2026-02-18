'use client'

import { memo, useState, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { Message } from '@/types'
import { useAppStore } from '@/stores/use-app-store'
import { AiAvatar } from '@/components/shared/avatar'
import { CodeBlock } from './code-block'

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

interface Props {
  message: Message
  assistantName?: string
}

export const MessageBubble = memo(function MessageBubble({ message, assistantName }: Props) {
  const isUser = message.role === 'user'
  const currentUser = useAppStore((s) => s.currentUser)
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(message.text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [message.text])

  return (
    <div
      className={`group ${isUser ? 'flex flex-col items-end' : 'flex flex-col items-start'}`}
      style={{ animation: `${isUser ? 'msg-in-right' : 'msg-in-left'} 0.35s cubic-bezier(0.16, 1, 0.3, 1)` }}
    >
      {/* Sender label + timestamp */}
      <div className={`flex items-center gap-2.5 mb-2 px-1 ${isUser ? 'flex-row-reverse' : ''}`}>
        {!isUser && <AiAvatar size="sm" />}
        <span className={`text-[12px] font-600 ${isUser ? 'text-accent-bright/70' : 'text-text-3'}`}>
          {isUser ? (currentUser ? currentUser.charAt(0).toUpperCase() + currentUser.slice(1) : 'You') : (assistantName || 'Claude')}
        </span>
        <span className="text-[11px] text-text-3/40 font-mono">
          {message.time ? fmtTime(message.time) : ''}
        </span>
      </div>

      {/* Message bubble */}
      <div className={`max-w-[85%] md:max-w-[72%] ${isUser ? 'bubble-user px-5 py-3.5' : 'bubble-ai px-5 py-3.5'}`}>
        {(message.imagePath || message.imageUrl) && (
          <img
            src={message.imageUrl || `/api/uploads/${message.imagePath?.split('/').pop()}`}
            alt="Attached"
            className="max-w-[240px] rounded-[12px] mb-3 border border-white/10"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
          />
        )}

        <div className={`msg-content text-[15px] break-words ${isUser ? 'leading-[1.6] text-white/95' : 'leading-[1.7] text-text'}`}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={{
              pre({ children }) {
                return <pre>{children}</pre>
              },
              code({ className, children }) {
                const isBlock = className?.startsWith('language-') || className?.startsWith('hljs')
                if (isBlock) {
                  return <CodeBlock className={className}>{children}</CodeBlock>
                }
                return <code className={className}>{children}</code>
              },
            }}
          >
            {message.text}
          </ReactMarkdown>
        </div>
      </div>

      {/* Action buttons (AI messages only) */}
      {!isUser && (
        <div className="flex items-center gap-1 mt-1.5 px-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] border-none bg-transparent
              text-[11px] font-500 text-text-3 cursor-pointer hover:text-text-2 hover:bg-white/[0.04] transition-all"
            style={{ fontFamily: 'inherit' }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
    </div>
  )
})
