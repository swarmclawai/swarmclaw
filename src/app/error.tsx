'use client'

import { useEffect } from 'react'

import { ErrorFallback } from '@/components/layout/error-fallback'
import { reportClientError } from '@/lib/app/report-client-error'

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    reportClientError({
      source: 'app-error',
      error,
      digest: error.digest,
    })
  }, [error])

  return (
    <ErrorFallback
      message="A route-level error interrupted the current view. Try the request again or reload the app."
      primaryLabel="Try Again"
      onPrimaryAction={() => reset()}
      secondaryLabel="Reload"
      onSecondaryAction={() => window.location.reload()}
    />
  )
}
