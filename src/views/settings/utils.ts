import { useCallback } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import type { AppSettings } from '@/types'

export const inputClass = "w-full px-4 py-3.5 rounded-[14px] border border-white/[0.08] bg-bg text-text text-[15px] outline-none transition-all duration-200 placeholder:text-text-3/50 focus-glow"

export function usePatchSettings() {
  const updateSettings = useAppStore((s) => s.updateSettings)
  return useCallback(
    (patch: Partial<AppSettings>) => updateSettings(patch),
    [updateSettings],
  )
}
