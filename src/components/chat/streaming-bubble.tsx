'use client'

import { useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { AiAvatar } from '@/components/shared/avatar'
import { CodeBlock } from './code-block'
import { ToolCallBubble } from './tool-call-bubble'
import { useChatStore } from '@/stores/use-chat-store'

interface Props {
  text: string
  assistantName?: string
}

export function StreamingBubble({ text, assistantName }: Props) {
  const rendered = useMemo(() => text, [text])
  const toolEvents = useChatStore((s) => s.toolEvents)

  return (
    <div
      className="flex flex-col items-start"
      style={{ animation: 'msg-in-left 0.35s cubic-bezier(0.16, 1, 0.3, 1)' }}
    >
      <div className="flex items-center gap-2.5 mb-2 px-1">
        <AiAvatar size="sm" />
        <span className="text-[12px] font-600 text-muted-foreground">{assistantName || 'Claude'}</span>
        <span className="w-2 h-2 rounded-full bg-primary" style={{ animation: 'pulse 1.5s ease infinite' }} />
      </div>

      {/* Tool call events */}
      {toolEvents.length > 0 && (
        <div className="max-w-[85%] md:max-w-[72%] flex flex-col gap-2 mb-2">
          {toolEvents.map((event) => (
            <ToolCallBubble key={event.id} event={event} />
          ))}
        </div>
      )}

      {rendered && (
        <div className="max-w-[85%] md:max-w-[72%] bubble-ai px-5 py-3.5">
          <div className="msg-content streaming-cursor text-[15px] leading-[1.7] break-words text-foreground">
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
                a({ href, children }) {
                  if (!href) return <>{children}</>
                  const ytMatch = href.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/)
                  if (ytMatch) {
                    return (
                      <div className="my-2">
                        <iframe
                          src={`https://www.youtube-nocookie.com/embed/${ytMatch[1]}`}
                          className="w-full aspect-video rounded-[10px] border border-border"
                          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                          allowFullScreen
                          title="YouTube video"
                        />
                      </div>
                    )
                  }
                  return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
                },
              }}
            >
              {rendered}
            </ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  )
}
