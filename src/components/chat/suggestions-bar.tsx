'use client'

import type { Message } from '@/types'

interface Props {
  lastMessage: Message | null
  onSend: (text: string) => void
}

function getSuggestions(msg: Message | null): string[] {
  if (!msg?.text) return ['Continue', 'Tell me more']
  const text = msg.text

  // Error patterns
  if (/error|exception|failed|traceback|panic|ECONNREFUSED|ETIMEDOUT/i.test(text)) {
    return ['Can you fix this?', 'Try an alternative approach', 'Explain the error']
  }

  // Code blocks present
  if (/```[\s\S]*```/.test(text)) {
    return ['Explain this code', 'Write tests for this', 'Any improvements?']
  }

  // File mentions
  if (/`\/[\w./-]+\.\w+`/.test(text) || /\b(created|modified|updated|wrote|saved)\b.*\b(file|files)\b/i.test(text)) {
    return ['Show me the file', 'Make changes to it', 'What else needs updating?']
  }

  // Task completion signals
  if (/\b(done|complete|finished|ready|all set|successfully)\b/i.test(text)) {
    return ["What's next?", 'Summarize what was done', 'Any remaining issues?']
  }

  // Question asked by assistant
  if (/\?\s*$/.test(text.trim())) {
    return ['Yes, go ahead', 'No, try a different approach', 'Tell me more about the options']
  }

  // List/steps presented
  if (/^\s*(\d+\.|[-*])\s/m.test(text)) {
    return ['Start with the first step', 'Can you elaborate?', 'Any alternatives?']
  }

  return ['Continue', 'Tell me more', 'Can you explain further?']
}

export function SuggestionsBar({ lastMessage, onSend }: Props) {
  const suggestions = lastMessage?.suggestions?.length === 3
    ? lastMessage.suggestions
    : getSuggestions(lastMessage)

  if (!suggestions.length) return null

  return (
    <div
      className="flex flex-wrap gap-2 px-1 pt-2"
      style={{ animation: 'fade-in 0.3s cubic-bezier(0.16, 1, 0.3, 1)' }}
    >
      {suggestions.map((text) => (
        <button
          key={text}
          type="button"
          onClick={() => onSend(text)}
          className="rounded-full px-3.5 py-1.5 text-[12px] font-500 border border-white/[0.06] bg-white/[0.03]
            text-text-3 hover:text-text-2 hover:bg-white/[0.06] hover:border-white/[0.10]
            cursor-pointer transition-all active:scale-[0.97]"
          style={{ fontFamily: 'inherit' }}
        >
          {text}
        </button>
      ))}
    </div>
  )
}
