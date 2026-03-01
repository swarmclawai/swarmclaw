'use client'

import { useCallback, useRef, useState } from 'react'

export type ContinuousSpeechState = 'idle' | 'listening' | 'cooldown' | 'waitingForResponse'

interface SpeechRecognitionResult {
  isFinal: boolean
  [index: number]: { transcript: string }
}

interface SpeechRecognitionResultList {
  readonly length: number
  [index: number]: SpeechRecognitionResult
}

interface SpeechRecognitionEvent {
  resultIndex: number
  results: SpeechRecognitionResultList
}

interface SpeechRecognitionErrorEvent {
  error: string
}

interface SpeechRecognitionInstance {
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  lang: string
  onresult: ((e: SpeechRecognitionEvent) => void) | null
  onerror: ((e: SpeechRecognitionErrorEvent) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
}

interface WindowWithSpeechRecognition {
  SpeechRecognition?: new () => SpeechRecognitionInstance
  webkitSpeechRecognition?: new () => SpeechRecognitionInstance
}

interface UseContinuousSpeechOptions {
  lang?: string
  silenceDelayMs?: number
  onUtterance: (transcript: string) => void
}

export function useContinuousSpeech(options: UseContinuousSpeechOptions) {
  const { lang, silenceDelayMs = 800, onUtterance } = options
  const [state, setState] = useState<ContinuousSpeechState>('idle')
  const [transcript, setTranscript] = useState('')
  const [interimText, setInterimText] = useState('')

  const recogRef = useRef<SpeechRecognitionInstance | null>(null)
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activeRef = useRef(false)
  const accumulatedRef = useRef('')

  const clearSilenceTimer = () => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current)
      silenceTimerRef.current = null
    }
  }

  const startRecognition = useCallback(() => {
    const w = window as unknown as WindowWithSpeechRecognition
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition
    if (!SR) return

    if (recogRef.current) {
      try { recogRef.current.stop() } catch { /* noop */ }
    }

    const recog = new SR()
    recog.continuous = true
    recog.interimResults = true
    recog.maxAlternatives = 1
    recog.lang = lang || navigator.language || 'en-US'

    recog.onresult = (e: SpeechRecognitionEvent) => {
      clearSilenceTimer()
      let interim = ''
      let final = ''

      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i]
        if (result.isFinal) {
          final += result[0].transcript
        } else {
          interim += result[0].transcript
        }
      }

      if (final) {
        accumulatedRef.current += (accumulatedRef.current ? ' ' : '') + final.trim()
        setTranscript(accumulatedRef.current)
        setInterimText('')

        // Start silence timer — after delay, send the utterance
        silenceTimerRef.current = setTimeout(() => {
          if (!activeRef.current) return
          const text = accumulatedRef.current.trim()
          if (text) {
            setState('waitingForResponse')
            onUtterance(text)
            accumulatedRef.current = ''
            setTranscript('')
          }
        }, silenceDelayMs)
      } else {
        setInterimText(interim)
      }
    }

    recog.onerror = (e: SpeechRecognitionErrorEvent) => {
      // 'no-speech' is normal during silence; 'aborted' when stopping intentionally
      if (e.error === 'no-speech' || e.error === 'aborted') return
      console.warn('[continuous-speech] error:', e.error)
    }

    recog.onend = () => {
      // Auto-restart if still active (browser may stop recognition periodically)
      if (activeRef.current && state !== 'waitingForResponse') {
        try { recog.start() } catch { /* noop */ }
      }
    }

    recogRef.current = recog
    try {
      recog.start()
      setState('listening')
    } catch {
      setState('idle')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, silenceDelayMs, onUtterance])

  const start = useCallback(() => {
    activeRef.current = true
    accumulatedRef.current = ''
    setTranscript('')
    setInterimText('')
    startRecognition()
  }, [startRecognition])

  const stop = useCallback(() => {
    activeRef.current = false
    clearSilenceTimer()
    if (recogRef.current) {
      try { recogRef.current.stop() } catch { /* noop */ }
      recogRef.current = null
    }
    setState('idle')
    setTranscript('')
    setInterimText('')
    accumulatedRef.current = ''
  }, [])

  const pause = useCallback(() => {
    clearSilenceTimer()
    if (recogRef.current) {
      try { recogRef.current.stop() } catch { /* noop */ }
    }
  }, [])

  const resume = useCallback(() => {
    if (!activeRef.current) return
    accumulatedRef.current = ''
    setTranscript('')
    setInterimText('')
    setState('listening')
    startRecognition()
  }, [startRecognition])

  const supported = typeof window !== 'undefined' &&
    !!((window as unknown as WindowWithSpeechRecognition).SpeechRecognition || (window as unknown as WindowWithSpeechRecognition).webkitSpeechRecognition)

  return { state, transcript, interimText, start, stop, pause, resume, supported }
}
