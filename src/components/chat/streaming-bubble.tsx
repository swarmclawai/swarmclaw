'use client'

import { useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { AiAvatar } from '@/components/shared/avatar'
import { CodeBlock } from './code-block'
import { ToolCallBubble } from './tool-call-bubble'
import { useChatStore, type ToolEvent } from '@/stores/use-chat-store'

function ToolEventsSection({ toolEvents }: { toolEvents: ToolEvent[] }) {
  const [expanded, setExpanded] = useState(false)
  const shouldCollapse = toolEvents.length > 2
  const latestTool = toolEvents[toolEvents.length - 1]

  if (shouldCollapse && !expanded) {
    return (
      <div className="max-w-[85%] md:max-w-[72%] flex flex-col gap-2 mb-2">
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="self-start flex items-center gap-2 px-3 py-1.5 rounded-[8px] bg-white/[0.04] hover:bg-white/[0.07] border border-white/[0.06] cursor-pointer transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-text-3/60">
            <polyline points="6 9 12 15 18 9" />
          </svg>
          <span className="text-[11px] text-text-3 font-mono">
            {toolEvents.length} tool calls
          </span>
          <span className="text-[10px] text-text-3/50">
            latest: {latestTool?.name || 'unknown'}
          </span>
        </button>
      </div>
    )
  }

  return (
    <div className="max-w-[85%] md:max-w-[72%] flex flex-col gap-2 mb-2">
      {shouldCollapse && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="self-start px-2.5 py-1 rounded-[8px] bg-white/[0.04] hover:bg-white/[0.07] text-[11px] text-text-3 border border-white/[0.06] cursor-pointer transition-colors"
        >
          Collapse tool calls
        </button>
      )}
      {toolEvents.map((event) => (
        <ToolCallBubble key={event.id} event={event} />
      ))}
    </div>
  )
}

interface Props {
  text: string
  assistantName?: string
}

export function StreamingBubble({ text, assistantName }: Props) {
  const rendered = useMemo(() => text, [text])
  const toolEvents = useChatStore((s) => s.toolEvents)
  const streamPhase = useChatStore((s) => s.streamPhase)
  const streamToolName = useChatStore((s) => s.streamToolName)

  return (
    <div
      className="flex flex-col items-start"
      style={{ animation: 'msg-in-left 0.35s cubic-bezier(0.16, 1, 0.3, 1)' }}
    >
      <div className="flex items-center gap-2.5 mb-2 px-1">
        <AiAvatar size="sm" mood={streamPhase === 'tool' ? 'tool' : 'thinking'} />
        <span className="text-[12px] font-600 text-text-3">{assistantName || 'Claude'}</span>
        <span className="w-2 h-2 rounded-full bg-accent-bright" style={{ animation: 'pulse 1.5s ease infinite' }} />
        {streamPhase === 'tool' && streamToolName && (
          <span className="text-[10px] text-text-3/50 font-mono">Using {streamToolName}...</span>
        )}
      </div>

      {/* Tool call events (collapsible when > 2) */}
      {toolEvents.length > 0 && (
        <ToolEventsSection toolEvents={toolEvents} />
      )}

      {rendered && (
        <div className="max-w-[85%] md:max-w-[72%] bubble-ai px-5 py-3.5">
          <div className="msg-content streaming-cursor text-[15px] leading-[1.7] break-words text-text">
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
                          className="w-full aspect-video rounded-[10px] border border-white/10"
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
