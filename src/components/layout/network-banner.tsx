'use client'

import { useAppStore } from '@/stores/use-app-store'

export function NetworkBanner() {
  const info = useAppStore((s) => s.networkInfo)
  if (!info) return null

  return (
    <div className="px-4 py-1.5 border-b border-white/[0.04] text-[10px] text-text-3 flex items-center gap-2 shrink-0">
      <span className="w-[5px] h-[5px] rounded-full bg-success shrink-0" />
      <code className="font-mono text-[10px] text-text-3/70 select-all">
        {info.ip}:{info.port}
      </code>
    </div>
  )
}
