'use client'

import { Component } from 'react'
import type { ReactNode, ErrorInfo } from 'react'

import { reportClientError } from '@/lib/app/report-client-error'
import { ErrorFallback } from '@/components/layout/error-fallback'

export class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { hasError: false }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  static getDerivedStateFromError(_error: Error) {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportClientError({
      source: 'error-boundary',
      error,
      componentStack: info.componentStack,
    })
  }

  render() {
    if (this.state.hasError) {
      return (
        <ErrorFallback
          message="An unexpected dashboard error occurred. Reload the page to recover."
          onPrimaryAction={() => window.location.reload()}
        />
      )
    }

    return this.props.children
  }
}
