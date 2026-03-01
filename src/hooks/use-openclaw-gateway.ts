'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api-client'
import { useWs } from './use-ws'

/** Call an OpenClaw gateway RPC method via the proxy route. */
export function useOpenClawRpc<T = unknown>(method: string | null, params?: unknown) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const paramsRef = useRef(params)
  paramsRef.current = params

  const fetch = useCallback(async () => {
    if (!method) return
    setLoading(true)
    setError(null)
    try {
      const res = await api<{ ok: boolean; result: T; error?: string }>('POST', '/openclaw/gateway', {
        method,
        params: paramsRef.current,
      })
      if (res.error) {
        setError(res.error)
      } else {
        setData(res.result)
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [method])

  useEffect(() => { fetch() }, [fetch])

  return { data, loading, error, refetch: fetch }
}

/** Subscribe to an OpenClaw event topic via the WS hub. */
export function useOpenClawEvent(topic: string, handler: () => void) {
  useWs(`openclaw:${topic}`, handler)
}

/** Check gateway connection status. */
export function useOpenClawConnected() {
  const [connected, setConnected] = useState(false)

  const check = useCallback(async () => {
    try {
      const res = await api<{ connected: boolean }>('GET', '/openclaw/gateway')
      setConnected(res.connected)
    } catch {
      setConnected(false)
    }
  }, [])

  useEffect(() => { check() }, [check])
  useWs('openclaw:agents', check)

  return connected
}
