/**
 * Streaming TTS utilities: sentence accumulation and ordered audio playback.
 */

// ---------------------------------------------------------------------------
// SentenceAccumulator — buffers text deltas, emits on sentence boundaries
// ---------------------------------------------------------------------------

export class SentenceAccumulator {
  private buffer = ''
  private onSentence: (sentence: string) => void

  constructor(onSentence: (sentence: string) => void) {
    this.onSentence = onSentence
  }

  push(delta: string) {
    this.buffer += delta
    // Emit on sentence-ending punctuation followed by space or newline
    const sentenceEnd = /([.!?])\s+/g
    let match: RegExpExecArray | null
    let lastIndex = 0
    while ((match = sentenceEnd.exec(this.buffer)) !== null) {
      const sentence = this.buffer.slice(lastIndex, match.index + 1).trim()
      if (sentence) this.onSentence(sentence)
      lastIndex = match.index + match[0].length
    }
    // Also emit on double newlines
    const doubleNewline = this.buffer.indexOf('\n\n', lastIndex)
    if (doubleNewline !== -1) {
      const sentence = this.buffer.slice(lastIndex, doubleNewline).trim()
      if (sentence) this.onSentence(sentence)
      lastIndex = doubleNewline + 2
    }
    // Flush if buffer exceeds 200 chars without a break
    if (this.buffer.length - lastIndex > 200) {
      const sentence = this.buffer.slice(lastIndex).trim()
      if (sentence) this.onSentence(sentence)
      lastIndex = this.buffer.length
    }
    this.buffer = this.buffer.slice(lastIndex)
  }

  flush() {
    const remaining = this.buffer.trim()
    if (remaining) this.onSentence(remaining)
    this.buffer = ''
  }
}

// ---------------------------------------------------------------------------
// AudioChunkQueue — ordered sequential playback of audio chunks
// ---------------------------------------------------------------------------

export class AudioChunkQueue {
  private queue: Promise<ArrayBuffer>[] = []
  private playing = false
  private audioCtx: AudioContext | null = null
  private currentSource: AudioBufferSourceNode | null = null
  private stopped = false
  onComplete?: () => void

  enqueue(fetchPromise: Promise<ArrayBuffer>) {
    this.queue.push(fetchPromise)
    if (!this.playing) this.playNext()
  }

  private async playNext() {
    if (this.stopped) return
    if (this.queue.length === 0) {
      this.playing = false
      this.onComplete?.()
      return
    }

    this.playing = true
    const bufferPromise = this.queue.shift()!
    try {
      if (!this.audioCtx) this.audioCtx = new AudioContext()
      if (this.audioCtx.state === 'suspended') await this.audioCtx.resume()

      const arrayBuffer = await bufferPromise
      if (this.stopped) return
      const audioBuffer = await this.audioCtx.decodeAudioData(arrayBuffer)
      if (this.stopped) return

      const source = this.audioCtx.createBufferSource()
      source.buffer = audioBuffer
      source.connect(this.audioCtx.destination)
      this.currentSource = source

      await new Promise<void>((resolve) => {
        source.onended = () => {
          this.currentSource = null
          resolve()
        }
        source.start()
      })
    } catch {
      // Skip failed chunks
    }

    if (!this.stopped) this.playNext()
  }

  stop() {
    this.stopped = true
    this.queue = []
    if (this.currentSource) {
      try { this.currentSource.stop() } catch { /* noop */ }
      this.currentSource = null
    }
    this.playing = false
  }
}

// ---------------------------------------------------------------------------
// Helper to fetch streaming TTS audio
// ---------------------------------------------------------------------------

export function fetchStreamTts(text: string): Promise<ArrayBuffer> {
  return fetch('/api/tts/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }).then((res) => {
    if (!res.ok) throw new Error(`TTS error: ${res.status}`)
    return res.arrayBuffer()
  })
}
