'use client'

import { useEffect } from 'react'

import './globals.css'

import { ErrorFallback } from '@/components/layout/error-fallback'
import { reportClientError } from '@/lib/app/report-client-error'

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string }
}) {
  useEffect(() => {
    reportClientError({
      source: 'global-error',
      error,
      digest: error.digest,
    })
  }, [error])

  return (
    <html lang="en" className="dark">
      <body className="antialiased">
        <ErrorFallback
          message="A fatal application error occurred before the normal shell could recover. Reload the app to continue."
          onPrimaryAction={() => window.location.reload()}
        />
      </body>
    </html>
  )
}
