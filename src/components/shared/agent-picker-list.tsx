'use client'

import { AgentAvatar } from '@/components/agents/agent-avatar'
import { CheckIcon } from '@/components/shared/check-icon'
import type { Agent } from '@/types'

interface Props {
  agents: Agent[]
  /** Currently selected agent ID(s). String for single-select, string[] for multi-select. */
  selected: string | string[]
  /** Called when an agent is clicked. In multi mode, caller should toggle; in single mode, set. */
  onSelect: (agentId: string) => void
  /** Show a "None" option at the top for optional single-select */
  noneOption?: { label: string; onSelect: () => void }
  /** Show delegation-capable badge */
  showOrchBadge?: boolean
  /** Max height of the scrollable list */
  maxHeight?: number
}

export function AgentPickerList({
  agents,
  selected,
  onSelect,
  noneOption,
  showOrchBadge,
  maxHeight = 220,
}: Props) {
  const isSelected = (id: string) =>
    Array.isArray(selected) ? selected.includes(id) : selected === id
  const noneSelected = Array.isArray(selected) ? selected.length === 0 : !selected

  if (agents.length === 0 && !noneOption) {
    return <p className="text-[13px] text-text-3">No agents configured.</p>
  }

  return (
    <div
      className="flex flex-col gap-1 rounded-[14px] border border-white/[0.06] bg-surface p-1.5 overflow-y-auto"
      style={{ maxHeight }}
    >
      {noneOption && (
        <button
          onClick={noneOption.onSelect}
          className={`relative flex items-center gap-3 px-3 py-2.5 rounded-[10px] cursor-pointer transition-all w-full text-left border-none
            ${noneSelected ? 'bg-accent-soft' : 'bg-transparent hover:bg-white/[0.03]'}`}
          style={{ fontFamily: 'inherit' }}
        >
          {noneSelected && (
            <div className="absolute left-0 top-2 bottom-2 w-[2.5px] rounded-full bg-accent-bright" />
          )}
          <div className="w-[28px] h-[28px] rounded-full bg-white/[0.06] flex items-center justify-center shrink-0">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={noneSelected ? 'text-accent-bright' : 'text-text-3'}>
              <circle cx="12" cy="12" r="10" /><line x1="8" y1="12" x2="16" y2="12" />
            </svg>
          </div>
          <span className={`text-[13px] font-600 flex-1 ${noneSelected ? 'text-accent-bright' : 'text-text-2'}`}>
            {noneOption.label}
          </span>
        </button>
      )}
      {agents.map((a) => {
        const active = isSelected(a.id)
        return (
          <button
            key={a.id}
            onClick={() => onSelect(a.id)}
            className={`relative flex items-center gap-3 px-3 py-2.5 rounded-[10px] cursor-pointer transition-all w-full text-left border-none
              ${active ? 'bg-accent-soft' : 'bg-transparent hover:bg-white/[0.03]'}`}
            style={{ fontFamily: 'inherit' }}
          >
            {active && (
              <div className="absolute left-0 top-2 bottom-2 w-[2.5px] rounded-full bg-accent-bright" />
            )}
            <AgentAvatar seed={a.avatarSeed || null} avatarUrl={a.avatarUrl} name={a.name} size={28} />
            <span className={`text-[13px] font-600 flex-1 truncate ${active ? 'text-accent-bright' : 'text-text-2'}`}>
              {a.name}
            </span>
            {showOrchBadge && a.platformAssignScope === 'all' && (
              <span className="text-[10px] text-text-3/60 flex items-center gap-0.5">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M16 3h5v5"/><path d="M21 3l-7 7"/><path d="M8 21H3v-5"/><path d="M3 21l7-7"/></svg>
              </span>
            )}
            {active && <CheckIcon className="text-accent-bright shrink-0" />}
          </button>
        )
      })}
    </div>
  )
}
