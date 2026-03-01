'use client'

import type { VoiceConversationState } from '@/hooks/use-voice-conversation'

interface VoiceOverlayProps {
  state: VoiceConversationState
  interimText: string
  transcript: string
  onStop: () => void
}

const STATE_LABELS: Record<VoiceConversationState, string> = {
  idle: '',
  listening: 'Listening...',
  processing: 'Processing...',
  speaking: 'Speaking...',
}

export function VoiceOverlay({ state, interimText, transcript, onStop }: VoiceOverlayProps) {
  if (state === 'idle') return null

  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-bg/90 backdrop-blur-sm">
      {/* Animated indicator */}
      <div className="relative">
        <div className={`w-20 h-20 rounded-full flex items-center justify-center ${
          state === 'listening'
            ? 'bg-accent/20 animate-pulse'
            : state === 'speaking'
              ? 'bg-green-500/20'
              : 'bg-yellow-500/20'
        }`}>
          <div className={`w-12 h-12 rounded-full flex items-center justify-center ${
            state === 'listening'
              ? 'bg-accent/30'
              : state === 'speaking'
                ? 'bg-green-500/30'
                : 'bg-yellow-500/30'
          }`}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={
              state === 'listening' ? 'text-accent-bright' : state === 'speaking' ? 'text-green-400' : 'text-yellow-400'
            }>
              {state === 'speaking' ? (
                <>
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                </>
              ) : (
                <>
                  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" x2="12" y1="19" y2="22" />
                </>
              )}
            </svg>
          </div>
        </div>
      </div>

      <div className="text-[14px] font-500 text-text-2">{STATE_LABELS[state]}</div>

      {/* Transcript display */}
      {(transcript || interimText) && (
        <div className="max-w-md px-6 text-center">
          {transcript && <p className="text-[14px] text-text-1 mb-1">{transcript}</p>}
          {interimText && <p className="text-[13px] text-text-3/60 italic">{interimText}</p>}
        </div>
      )}

      {/* Stop button */}
      <button
        onClick={onStop}
        className="mt-2 px-5 py-2 rounded-lg bg-red-500/10 text-red-400 text-[13px] font-600 hover:bg-red-500/20 transition-colors"
      >
        Stop Voice
      </button>
    </div>
  )
}
