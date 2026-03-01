'use client'

import { useCallback, useRef, useState } from 'react'
import { useContinuousSpeech } from './use-continuous-speech'
import { SentenceAccumulator, AudioChunkQueue, fetchStreamTts } from '@/lib/tts-stream'
import { useChatStore } from '@/stores/use-chat-store'

export type VoiceConversationState = 'idle' | 'listening' | 'processing' | 'speaking'

export function useVoiceConversation() {
  const [active, setActive] = useState(false)
  const [voiceState, setVoiceState] = useState<VoiceConversationState>('idle')
  const accumulatorRef = useRef<SentenceAccumulator | null>(null)
  const queueRef = useRef<AudioChunkQueue | null>(null)
  const sendMessage = useChatStore((s) => s.sendMessage)

  const speech = useContinuousSpeech({
    onUtterance: useCallback((text: string) => {
      setVoiceState('processing')
      // Send the transcribed text as a chat message
      sendMessage(text)
    }, [sendMessage]),
  })

  // Called by the chat store's onStreamEvent callback
  const handleStreamEvent = useCallback((event: { t: string; text?: string }) => {
    if (!active) return

    if (event.t === 'd' && event.text) {
      setVoiceState('speaking')
      if (!accumulatorRef.current) {
        const queue = new AudioChunkQueue()
        queueRef.current = queue
        queue.onComplete = () => {
          // Resume listening after TTS playback finishes
          setVoiceState('listening')
          speech.resume()
        }
        accumulatorRef.current = new SentenceAccumulator((sentence) => {
          queue.enqueue(fetchStreamTts(sentence))
        })
      }
      accumulatorRef.current.push(event.text)
    } else if (event.t === 'done') {
      // Flush remaining text to TTS
      if (accumulatorRef.current) {
        accumulatorRef.current.flush()
        accumulatorRef.current = null
      }
    }
  }, [active, speech])

  const start = useCallback(() => {
    setActive(true)
    setVoiceState('listening')
    // Register the stream event handler on the chat store
    useChatStore.setState({ onStreamEvent: handleStreamEvent, voiceConversationActive: true })
    speech.start()
  }, [speech, handleStreamEvent])

  const stop = useCallback(() => {
    setActive(false)
    setVoiceState('idle')
    speech.stop()
    queueRef.current?.stop()
    queueRef.current = null
    accumulatorRef.current = null
    useChatStore.setState({ onStreamEvent: null, voiceConversationActive: false })
  }, [speech])

  return {
    active,
    state: voiceState,
    interimText: speech.interimText,
    transcript: speech.transcript,
    supported: speech.supported,
    start,
    stop,
  }
}
