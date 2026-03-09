import { useEffect, useRef } from 'react'

export function useMountedRef() {
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  return mountedRef
}
