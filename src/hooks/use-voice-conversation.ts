'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useContinuousSpeech } from './use-continuous-speech'
import { SentenceAccumulator, AudioChunkQueue, fetchStreamTts } from '@/lib/tts-stream'
import { useChatStore } from '@/stores/use-chat-store'

export type VoiceConversationState = 'idle' | 'listening' | 'processing' | 'speaking'

/** Max time to wait in 'processing' before falling back to listening (30s). */
const PROCESSING_TIMEOUT_MS = 30_000

export function useVoiceConversation() {
  const [voiceState, setVoiceState] = useState<VoiceConversationState>('idle')
  const accumulatorRef = useRef<SentenceAccumulator | null>(null)
  const queueRef = useRef<AudioChunkQueue | null>(null)
  const activeRef = useRef(false)
  const processingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [resumeNeeded, setResumeNeeded] = useState(0)
  const sendMessage = useChatStore((s) => s.sendMessage)

  const clearProcessingTimer = () => {
    if (processingTimerRef.current) {
      clearTimeout(processingTimerRef.current)
      processingTimerRef.current = null
    }
  }

  const speech = useContinuousSpeech({
    onUtterance: useCallback((text: string) => {
      setVoiceState('processing')
      sendMessage(text)
      // Safety net: if no stream events arrive within timeout, resume listening
      clearProcessingTimer()
      processingTimerRef.current = setTimeout(() => {
        if (activeRef.current) {
          setVoiceState('listening')
          setResumeNeeded((n) => n + 1)
        }
      }, PROCESSING_TIMEOUT_MS)
    }, [sendMessage]),
  })

  // When resumeNeeded increments, call speech.resume
  useEffect(() => {
    if (resumeNeeded > 0) speech.resume()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeNeeded])

  // Called by the chat store's onStreamEvent callback
  const handleStreamEvent = useCallback((event: { t: string; text?: string }) => {
    if (!activeRef.current) return

    if (event.t === 'd' && event.text) {
      clearProcessingTimer()
      setVoiceState('speaking')
      if (!accumulatorRef.current) {
        const queue = new AudioChunkQueue()
        queueRef.current = queue
        queue.onComplete = () => {
          // Resume listening after TTS playback finishes
          if (activeRef.current) {
            setVoiceState('listening')
            speech.resume()
          }
        }
        accumulatorRef.current = new SentenceAccumulator((sentence) => {
          queue.enqueue(fetchStreamTts(sentence))
        })
      }
      accumulatorRef.current.push(event.text)
    } else if (event.t === 'done') {
      clearProcessingTimer()
      // Flush remaining text to TTS
      if (accumulatorRef.current) {
        accumulatorRef.current.flush()
        accumulatorRef.current = null
      } else {
        // No text was streamed (empty response or error) — resume listening
        if (activeRef.current) {
          setVoiceState('listening')
          speech.resume()
        }
      }
    } else if (event.t === 'err') {
      // Error from the LLM — resume listening instead of staying stuck
      clearProcessingTimer()
      if (activeRef.current) {
        setVoiceState('listening')
        speech.resume()
      }
    }
  }, [speech])

  const start = useCallback(() => {
    activeRef.current = true
    setVoiceState('listening')
    // Register the stream event handler on the chat store
    useChatStore.setState({ onStreamEvent: handleStreamEvent, voiceConversationActive: true })
    speech.start()
  }, [speech, handleStreamEvent])

  const stop = useCallback(() => {
    activeRef.current = false
    setVoiceState('idle')
    clearProcessingTimer()
    speech.stop()
    queueRef.current?.stop()
    queueRef.current = null
    accumulatorRef.current = null
    useChatStore.setState({ onStreamEvent: null, voiceConversationActive: false })
  }, [speech])

  return {
    active: activeRef.current || voiceState !== 'idle',
    state: voiceState,
    interimText: speech.interimText,
    transcript: speech.transcript,
    supported: speech.supported,
    start,
    stop,
  }
}
