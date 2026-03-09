import { useEffect, useState } from 'react'

interface UseNowOptions {
  enabled?: boolean
  intervalMs?: number
}

export function useNow(options: UseNowOptions = {}): number | null {
  const { enabled = true, intervalMs = 60_000 } = options
  const [now, setNow] = useState<number | null>(null)

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setNow(Date.now())
    })
    if (!enabled || intervalMs <= 0) {
      return () => window.cancelAnimationFrame(frame)
    }

    const timer = window.setInterval(() => {
      setNow(Date.now())
    }, intervalMs)

    return () => {
      window.cancelAnimationFrame(frame)
      window.clearInterval(timer)
    }
  }, [enabled, intervalMs])

  return now
}
