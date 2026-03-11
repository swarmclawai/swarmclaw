/**
 * Lightweight page-level loader — smaller sibling of FullScreenLoader.
 * 3 orbiting dots, subtle glow ring, optional label.
 * 150ms CSS animation-delay prevents flicker on fast loads.
 */
export function PageLoader({ label }: { label?: string }) {
  return (
    <div
      className="flex-1 flex flex-col items-center justify-center select-none"
      style={{
        opacity: 0,
        animation: 'fade-up 0.4s var(--ease-spring) 0.15s both',
      }}
    >
      {/* Orbital ring */}
      <div className="relative w-[64px] h-[64px] mb-5">
        {/* Glow pulse */}
        <div
          className="absolute inset-[-12px] rounded-full"
          style={{
            background: 'radial-gradient(circle, rgba(99,102,241,0.06) 0%, transparent 70%)',
            animation: 'sc-glow 2.5s ease-in-out infinite',
          }}
        />

        {/* Ring */}
        <div
          className="absolute inset-0 rounded-full border border-white/[0.05]"
          style={{ animation: 'sc-ring 3s linear infinite' }}
        />

        {/* 3 orbiting dots */}
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="absolute inset-0"
            style={{
              animation: 'sc-orbit 2.4s cubic-bezier(0.4, 0, 0.2, 1) infinite',
              animationDelay: `${i * -0.8}s`,
            }}
          >
            <div
              className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={{
                width: i === 0 ? 6 : 5,
                height: i === 0 ? 6 : 5,
                background: i === 0 ? '#818CF8' : `rgba(129, 140, 248, ${0.6 - i * 0.15})`,
                boxShadow: i === 0 ? '0 0 10px rgba(99,102,241,0.4)' : 'none',
              }}
            />
          </div>
        ))}
      </div>

      {/* Shimmer bar */}
      <div className="w-[60px] h-[2px] rounded-full bg-white/[0.05] overflow-hidden">
        <div
          className="h-full rounded-full bg-accent-bright/50"
          style={{ animation: 'sc-progress 1.5s ease-in-out infinite' }}
        />
      </div>

      {/* Optional label */}
      {label && (
        <p className="mt-3 text-[12px] text-text-3/60">{label}</p>
      )}
    </div>
  )
}
