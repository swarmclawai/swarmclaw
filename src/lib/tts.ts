let audioCtx: AudioContext | null = null
let currentSource: AudioBufferSourceNode | null = null

function ensureContext() {
  if (!audioCtx) audioCtx = new AudioContext()
  if (audioCtx.state === 'suspended') audioCtx.resume()
}

export function initAudioContext() {
  ensureContext()
}

export async function speak(text: string) {
  if (currentSource) {
    try { currentSource.stop() } catch { /* noop */ }
    currentSource = null
  }
  ensureContext()
  if (!audioCtx) return

  const res = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text.slice(0, 2000) }),
  })
  if (!res.ok) return

  const buf = await res.arrayBuffer()
  const audio = await audioCtx.decodeAudioData(buf)
  currentSource = audioCtx.createBufferSource()
  currentSource.buffer = audio
  currentSource.connect(audioCtx.destination)
  currentSource.onended = () => { currentSource = null }
  currentSource.start()
}

export function stopSpeaking() {
  if (currentSource) {
    try { currentSource.stop() } catch { /* noop */ }
    currentSource = null
  }
}
