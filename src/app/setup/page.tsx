'use client'

import { useRouter } from 'next/navigation'
import { safeStorageSet } from '@/lib/app/safe-storage'
import { HOME_LAUNCHPAD_AFTER_SETUP_KEY } from '@/lib/home-launchpad'
import { SetupWizard } from '@/components/auth/setup-wizard'

export default function SetupPage() {
  const router = useRouter()
  return (
    <SetupWizard
      onComplete={(destination) => {
        safeStorageSet('sc_setup_done', '1')
        safeStorageSet(HOME_LAUNCHPAD_AFTER_SETUP_KEY, '1')
        window.dispatchEvent(new Event('sc:setup-complete'))
        router.replace(destination || '/home')
      }}
    />
  )
}
