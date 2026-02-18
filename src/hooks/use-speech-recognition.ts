'use client'

import { useCallback, useRef, useState } from 'react'

interface SpeechRecognitionEvent {
  results: { [index: number]: { [index: number]: { transcript: string } } }
}

export function useSpeechRecognition(onResult: (text: string) => void) {
  const [recording, setRecording] = useState(false)
  const recogRef = useRef<any>(null)

  const toggle = useCallback(() => {
    if (recording) {
      recogRef.current?.stop()
      setRecording(false)
      return
    }

    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SR) return

    const recog = new SR()
    recog.continuous = false
    recog.interimResults = false
    recog.lang = 'en-AU'

    recog.onresult = (e: SpeechRecognitionEvent) => {
      setRecording(false)
      onResult(e.results[0][0].transcript)
    }
    recog.onerror = () => setRecording(false)
    recog.onend = () => setRecording(false)

    recogRef.current = recog
    setRecording(true)
    try { recog.start() } catch { setRecording(false) }
  }, [recording, onResult])

  const supported = typeof window !== 'undefined' &&
    !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)

  return { recording, toggle, supported }
}
