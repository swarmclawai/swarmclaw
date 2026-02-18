'use client'

import { useCallback, useEffect, useRef } from 'react'

export function useAutoResize(maxHeight = 120) {
  const ref = useRef<HTMLTextAreaElement>(null)

  const resize = useCallback(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, maxHeight) + 'px'
  }, [maxHeight])

  useEffect(() => {
    resize()
  }, [resize])

  return { ref, resize }
}
