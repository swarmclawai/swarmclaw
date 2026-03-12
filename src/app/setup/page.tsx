'use client'

import { useRouter } from 'next/navigation'
import { safeStorageSet } from '@/lib/app/safe-storage'
import { SetupWizard } from '@/components/auth/setup-wizard'

export default function SetupPage() {
  const router = useRouter()
  return (
    <SetupWizard
      onComplete={() => {
        safeStorageSet('sc_setup_done', '1')
        window.dispatchEvent(new Event('sc:setup-complete'))
        router.replace('/home')
      }}
    />
  )
}
