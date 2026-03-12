'use client'

import { AccessKeyGate } from '@/components/auth/access-key-gate'

export default function LoginPage() {
  return <AccessKeyGate onAuthenticated={() => {
    // Full navigation so the bootstrap re-checks auth from scratch with the new cookie.
    window.location.replace('/home')
  }} />
}
