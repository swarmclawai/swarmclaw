import type { ConfiguredProvider } from './types'
import { OPENCLAW_USE_CASE_LABELS, OPENCLAW_EXPOSURE_LABELS } from './types'
import { formatEndpointHost } from './utils'

export function SparkleIcon() {
  return (
    <div className="flex justify-center mb-6">
      <div className="relative w-12 h-12">
        <svg
          width="48"
          height="48"
          viewBox="0 0 48 48"
          fill="none"
          className="text-accent-bright"
          style={{ animation: 'sparkle-spin 8s linear infinite' }}
        >
          <path
            d="M24 4L27.5 18.5L42 24L27.5 29.5L24 44L20.5 29.5L6 24L20.5 18.5L24 4Z"
            fill="currentColor"
            opacity="0.9"
          />
        </svg>
        <div className="absolute inset-0 blur-xl bg-accent-bright/20" />
      </div>
    </div>
  )
}

export function StepShell({ wide, children }: { wide?: boolean; children: React.ReactNode }) {
  return (
    <div
      className={`relative ${wide ? 'max-w-[920px]' : 'max-w-[760px]'} w-full text-center`}
      style={{ animation: 'spring-in 0.5s var(--ease-spring, cubic-bezier(0.16, 1, 0.3, 1)) both' }}
    >
      {children}
    </div>
  )
}

export function SkipLink({ onClick, label }: { onClick: () => void; label?: string }) {
  return (
    <button
      onClick={onClick}
      className="mt-8 text-[13px] text-text-3 hover:text-text-2 transition-colors cursor-pointer bg-transparent border-none"
    >
      {label || 'Skip setup for now'}
    </button>
  )
}

export function ConfiguredProviderChips({
  providers,
  onRemove,
}: {
  providers: ConfiguredProvider[]
  onRemove?: (id: string) => void
}) {
  if (providers.length === 0) return null
  return (
    <div className="flex flex-wrap gap-2 justify-center mb-6">
      {providers.map((cp) => (
        <span
          key={cp.id}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/25 text-emerald-300 text-[12px] font-500"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
          {cp.name}
          <span className="text-emerald-300/70">
            {formatEndpointHost(cp.endpoint)
              ? `· ${formatEndpointHost(cp.endpoint)}`
              : ''}
            {cp.provider === 'openclaw' && cp.deployment?.useCase
              ? ` · ${OPENCLAW_USE_CASE_LABELS[cp.deployment.useCase]}`
              : ''}
            {cp.provider === 'openclaw' && cp.deployment?.exposure
              ? ` · ${OPENCLAW_EXPOSURE_LABELS[cp.deployment.exposure]}`
              : ''}
            {cp.defaultModel ? ` · ${cp.defaultModel}` : ''}
          </span>
          {onRemove && (
            <button
              type="button"
              onClick={() => onRemove(cp.id)}
              className="ml-0.5 text-emerald-300/50 hover:text-red-300 transition-colors bg-transparent border-none cursor-pointer p-0 leading-none"
              title={`Remove ${cp.name}`}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </span>
      ))}
    </div>
  )
}
