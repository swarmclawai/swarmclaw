'use client'

import { Component } from 'react'
import type { ReactNode, ErrorInfo } from 'react'

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
    console.error('ErrorBoundary caught:', error, info)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center px-8 bg-bg">
          <div className="text-center max-w-[400px]">
            <div className="w-14 h-14 rounded-[16px] bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto mb-5">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-red-400">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </div>
            <h2 className="font-display text-[22px] font-700 text-text mb-2 tracking-[-0.02em]">
              Something went wrong
            </h2>
            <p className="text-[14px] text-text-3 mb-6">
              An unexpected error occurred. Try reloading the page.
            </p>
            <button
              onClick={() => window.location.reload()}
              className="inline-flex items-center gap-2 px-6 py-3 rounded-[12px] border-none bg-accent-bright text-white text-[14px] font-600 cursor-pointer
                hover:brightness-110 active:scale-[0.97] transition-all shadow-[0_4px_16px_rgba(99,102,241,0.2)]"
              style={{ fontFamily: 'inherit' }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
              Reload
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
