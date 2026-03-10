'use client'

import type { ReactNode } from 'react'
import { useMediaQuery } from '@/hooks/use-media-query'
import { MobileHeader } from '@/components/layout/mobile-header'
import { NetworkBanner } from '@/components/layout/network-banner'
import { UpdateBanner } from '@/components/layout/update-banner'

export function MainContent({ children }: { children: ReactNode }) {
  const isDesktop = useMediaQuery('(min-width: 768px)')

  return (
    <div className="flex-1 flex flex-col h-full min-h-0 min-w-0 bg-bg">
      {!isDesktop && <MobileHeader />}
      <NetworkBanner />
      <UpdateBanner />
      {children}
    </div>
  )
}
