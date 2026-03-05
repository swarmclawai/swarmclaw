interface Props {
  icon: React.ReactNode
  title: string
  subtitle?: string
  action?: {
    label: string
    onClick: () => void
  }
}

export function EmptyState({ icon, title, subtitle, action }: Props) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 text-text-3 p-8 text-center group/empty">
      <div
        className="w-14 h-14 rounded-[16px] bg-accent-soft flex items-center justify-center mb-1 relative"
        style={{ animation: 'float 4s ease-in-out infinite' }}
      >
        <div className="text-accent-bright transition-transform duration-500 group-hover/empty:scale-110 group-hover/empty:rotate-[10deg]">
          {icon}
        </div>
        {/* Subtle glow background */}
        <div className="absolute inset-0 bg-accent-bright/5 blur-xl rounded-full opacity-0 group-hover/empty:opacity-100 transition-opacity" />
      </div>
      <div style={{ animation: 'fade-up 0.5s var(--ease-spring) both' }}>
        <p className="font-display text-[15px] font-600 text-text-2">{title}</p>
        {subtitle && <p className="text-[13px] text-text-3/50 mt-1">{subtitle}</p>}
      </div>
      {action && (
        <button
          onClick={action.onClick}
          className="mt-3 px-8 py-3 rounded-[14px] border-none bg-accent-bright text-white
            text-[14px] font-600 cursor-pointer active:scale-95 transition-all duration-200
            shadow-[0_4px_16px_rgba(99,102,241,0.2)] relative overflow-hidden group/btn"
          style={{ fontFamily: 'inherit', animation: 'spring-in 0.6s var(--ease-spring) 0.2s both' }}
        >
          <span className="relative z-10">{action.label}</span>
          <div
            className="absolute inset-0 w-full h-full bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full group-hover/btn:animate-[shimmer-bar_1.5s_ease-in-out_infinite]"
          />
        </button>
      )}
    </div>
  )
}
