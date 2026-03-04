import { useRef, useCallback } from 'react'

interface UseSwipeOptions {
  onSwipe: (direction: 'left' | 'right') => void
  /** Only trigger right-swipe from this many pixels from the left edge */
  edgeWidth?: number
  /** Minimum horizontal distance to count as a swipe */
  threshold?: number
  /** Whether left-swipe is currently allowed (e.g. sidebar is open) */
  leftSwipeEnabled?: boolean
}

export function useSwipe({
  onSwipe,
  edgeWidth = 40,
  threshold = 50,
  leftSwipeEnabled = false,
}: UseSwipeOptions) {
  const startX = useRef(0)
  const startY = useRef(0)
  const isEdge = useRef(false)

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0]
    startX.current = touch.clientX
    startY.current = touch.clientY
    isEdge.current = touch.clientX <= edgeWidth
  }, [edgeWidth])

  // No-op — we only evaluate on touchend, but callers may wire this for consistency
  const onTouchMove = useCallback(() => {}, [])

  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    const touch = e.changedTouches[0]
    const dx = touch.clientX - startX.current
    const dy = touch.clientY - startY.current
    // Ignore if vertical movement dominates
    if (Math.abs(dy) > Math.abs(dx)) return
    if (Math.abs(dx) < threshold) return

    if (dx > 0 && isEdge.current) {
      onSwipe('right')
    } else if (dx < 0 && leftSwipeEnabled) {
      onSwipe('left')
    }
  }, [threshold, leftSwipeEnabled, onSwipe])

  return { onTouchStart, onTouchMove, onTouchEnd }
}
