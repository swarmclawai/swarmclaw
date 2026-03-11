export function FullScreenLoader(props: {
  stage?: string | null
  stalled?: boolean
  onReload?: () => void
  onReset?: () => void
}) {
  return (
    <div className="h-full flex flex-col items-center justify-center bg-bg overflow-hidden select-none">
      {/* Animated orbital ring */}
      <div className="relative w-[120px] h-[120px] mb-8">
        {/* Outer glow pulse */}
        <div
          className="absolute inset-[-20px] rounded-full"
          style={{
            background: 'radial-gradient(circle, rgba(99,102,241,0.08) 0%, transparent 70%)',
            animation: 'sc-glow 2.5s ease-in-out infinite',
          }}
        />

        {/* Orbital ring */}
        <div
          className="absolute inset-0 rounded-full border border-white/[0.06]"
          style={{ animation: 'sc-ring 3s linear infinite' }}
        />

        {/* Orbiting dots */}
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            className="absolute inset-0"
            style={{
              animation: `sc-orbit 2.4s cubic-bezier(0.4, 0, 0.2, 1) infinite`,
              animationDelay: `${i * -0.4}s`,
            }}
          >
            <div
              className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={{
                width: i === 0 ? 8 : 6,
                height: i === 0 ? 8 : 6,
                background: i === 0 ? '#818CF8' : `rgba(129, 140, 248, ${0.7 - i * 0.1})`,
                boxShadow: i === 0 ? '0 0 12px rgba(99,102,241,0.5)' : 'none',
              }}
            />
          </div>
        ))}

        {/* Center logo mark */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div
            className="relative"
            style={{ animation: 'sc-breathe 2.5s ease-in-out infinite' }}
          >
            <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
              {/* Hexagonal claw mark */}
              <path
                d="M18 4L30 11V25L18 32L6 25V11L18 4Z"
                stroke="rgba(129, 140, 248, 0.3)"
                strokeWidth="1"
                fill="none"
              />
              <path
                d="M18 9L25 13V23L18 27L11 23V13L18 9Z"
                stroke="rgba(129, 140, 248, 0.5)"
                strokeWidth="1.5"
                fill="rgba(99, 102, 241, 0.06)"
              />
              {/* Claw lines */}
              <path d="M14 15L18 20L22 15" stroke="#818CF8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M12 13L18 20L24 13" stroke="rgba(129, 140, 248, 0.3)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        </div>
      </div>

      {/* Brand text */}
      <div
        className="text-[15px] font-display font-700 tracking-[0.15em] uppercase"
        style={{
          background: 'linear-gradient(135deg, rgba(255,255,255,0.6), rgba(129, 140, 248, 0.8))',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          animation: 'sc-text-fade 2s ease-in-out infinite alternate, fade-up 0.6s var(--ease-spring) 0.2s both',
        }}
      >
        SwarmClaw
      </div>

      {/* Loading bar */}
      <div className="mt-4 w-[100px] h-[2px] rounded-full bg-white/[0.06] overflow-hidden" style={{ animation: 'fade-up 0.6s var(--ease-spring) 0.3s both' }}>
        <div
          className="h-full rounded-full bg-accent-bright/60"
          style={{ animation: 'sc-progress 1.5s ease-in-out infinite' }}
        />
      </div>

      {props.stage ? (
        <p
          className="mt-4 text-[12px] text-text-3"
          style={{ animation: 'fade-up 0.6s var(--ease-spring) 0.4s both' }}
        >
          {props.stage}
        </p>
      ) : null}

      {props.stalled ? (
        <div
          className="mt-6 max-w-[360px] px-4 text-center"
          style={{ animation: 'fade-up 0.6s var(--ease-spring) 0.5s both' }}
        >
          <p className="text-[12px] text-text-2">
            Startup is taking longer than expected. This usually means the browser kept stale local state while the dev server restarted.
          </p>
          <div className="mt-4 flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={props.onReload}
              className="px-4 py-2 rounded-[12px] border border-white/[0.08] bg-surface text-[12px] text-text-2 transition-colors hover:bg-surface-2"
            >
              Reload
            </button>
            <button
              type="button"
              onClick={props.onReset}
              className="px-4 py-2 rounded-[12px] border border-white/[0.08] bg-transparent text-[12px] text-text-3 transition-colors hover:bg-white/[0.04]"
            >
              Reset Local Session
            </button>
          </div>
        </div>
      ) : null}

    </div>
  )
}