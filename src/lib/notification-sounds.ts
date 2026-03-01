let ctx: AudioContext | null = null

function ensureCtx(): AudioContext | null {
  if (!ctx) {
    try { ctx = new AudioContext() } catch { return null }
  }
  if (ctx.state === 'suspended') ctx.resume()
  return ctx
}

function tone(freq: number, duration: number, type: OscillatorType = 'sine', delay = 0) {
  const c = ensureCtx()
  if (!c) return
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = type
  osc.frequency.value = freq
  gain.gain.setValueAtTime(0.12, c.currentTime + delay)
  gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + delay + duration / 1000)
  osc.connect(gain)
  gain.connect(c.destination)
  osc.start(c.currentTime + delay)
  osc.stop(c.currentTime + delay + duration / 1000)
}

/** Two ascending tones: C5 → E5 */
export function playStreamStart() {
  tone(523, 80, 'sine', 0)
  tone(659, 80, 'sine', 0.09)
}

/** Two descending tones: E5 → C5 */
export function playStreamEnd() {
  tone(659, 80, 'sine', 0)
  tone(523, 80, 'sine', 0.09)
}

/** Single ding: A5 */
export function playToolComplete() {
  tone(880, 120, 'triangle')
}

/** Low buzz: A3 */
export function playError() {
  tone(220, 200, 'square')
}

const LS_KEY = 'sc_sound_notifications'

export function getSoundEnabled(): boolean {
  if (typeof window === 'undefined') return false
  return localStorage.getItem(LS_KEY) === '1'
}

export function setSoundEnabled(v: boolean) {
  if (typeof window === 'undefined') return
  localStorage.setItem(LS_KEY, v ? '1' : '0')
}
