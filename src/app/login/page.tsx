'use client'

import { useRouter } from 'next/navigation'
import { AccessKeyGate } from '@/components/auth/access-key-gate'

export default function LoginPage() {
  const router = useRouter()
  return <AccessKeyGate onAuthenticated={() => router.replace('/home')} />
}
