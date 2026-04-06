type LaunchActionCardProps = {
  title: string
  description: string
  actionLabel: string
  onClick: () => void
  tone?: 'primary' | 'default'
}

export function LaunchActionCard({ title, description, actionLabel, onClick, tone = 'default' }: LaunchActionCardProps) {
  return (
    <div className="rounded-[18px] border border-white/[0.06] bg-white/[0.03] p-4">
      <div className="text-[15px] font-display font-700 text-text">{title}</div>
      <p className="mt-2 text-[13px] leading-relaxed text-text-3/72">{description}</p>
      <button
        type="button"
        onClick={onClick}
        className={`mt-4 rounded-[12px] px-4 py-2.5 text-[13px] font-display font-700 transition-all cursor-pointer ${
          tone === 'primary'
            ? 'bg-accent-bright text-black hover:opacity-90'
            : 'border border-white/[0.08] bg-white/[0.04] text-text-2 hover:bg-white/[0.08]'
        }`}
      >
        {actionLabel}
      </button>
    </div>
  )
}
