'use client'

import { useState, useRef, useEffect } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { api } from '@/lib/api-client'
import { AVAILABLE_TOOLS, PLATFORM_TOOLS, TOOL_LABELS } from '@/lib/tool-definitions'
import type { ToolDefinition } from '@/lib/tool-definitions'
import type { Session } from '@/types'

const TOOL_GROUPS: { label: string; tools: ToolDefinition[] }[] = [
  { label: 'Tools', tools: AVAILABLE_TOOLS },
  { label: 'Platform', tools: PLATFORM_TOOLS },
]

const TOTAL_TOOL_COUNT = AVAILABLE_TOOLS.length + PLATFORM_TOOLS.length

interface Props {
  session: Session
}

export function ChatToolToggles({ session }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const loadSessions = useAppStore((s) => s.loadSessions)
  const agents = useAppStore((s) => s.agents)
  const skills = useAppStore((s) => s.skills)

  const agent = session.agentId ? agents[session.agentId] : null
  const sessionTools: string[] = session.tools || []

  // Agent's skill IDs
  const agentSkillIds: string[] = agent?.skillIds || []

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const toggleTool = async (toolId: string) => {
    const updated = sessionTools.includes(toolId)
      ? sessionTools.filter((t) => t !== toolId)
      : [...sessionTools, toolId]
    await api('PUT', `/sessions/${session.id}`, { tools: updated })
    loadSessions()
  }

  const enabledCount = sessionTools.length
  const totalCount = TOTAL_TOOL_COUNT

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-[8px] transition-colors cursor-pointer border-none
          ${open ? 'bg-accent-soft text-accent-bright' : 'bg-white/[0.04] text-text-3 hover:bg-white/[0.07]'}`}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
        <span className="text-[11px] font-600">
          {enabledCount}/{totalCount}
        </span>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1.5 w-[260px] max-h-[420px] overflow-y-auto rounded-[12px] border border-white/[0.08] shadow-xl z-[120] overflow-hidden"
          style={{ animation: 'fade-in 0.15s ease', backgroundColor: '#171a2b' }}>

          {TOOL_GROUPS.map((group, gi) => (
            <div key={group.label} className={`px-3 pb-1 ${gi === 0 ? 'pt-3' : 'pt-1 border-t border-white/[0.04]'}`}>
              <p className="text-[10px] font-600 text-text-3/60 uppercase tracking-wider mb-2">{group.label}</p>
              {group.tools.map((tool) => {
                const enabled = sessionTools.includes(tool.id)
                return (
                  <label key={tool.id} className="flex items-center gap-2.5 py-1.5 cursor-pointer">
                    <div
                      onClick={() => toggleTool(tool.id)}
                      className={`w-8 h-[18px] rounded-full transition-all duration-200 relative cursor-pointer shrink-0
                        ${enabled ? 'bg-[#6366F1]' : 'bg-white/[0.12]'}`}
                    >
                      <div className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white transition-all duration-200
                        ${enabled ? 'left-[16px]' : 'left-[2px]'}`} />
                    </div>
                    <span className={`text-[12px] ${enabled ? 'text-text-2' : 'text-text-3/70'}`}>
                      {tool.label}
                    </span>
                  </label>
                )
              })}
            </div>
          ))}

          {agentSkillIds.length > 0 && (
            <div className="px-3 pb-2 pt-1 border-t border-white/[0.04]">
              <p className="text-[10px] font-600 text-text-3/60 uppercase tracking-wider mb-2">Skills</p>
              {agentSkillIds.map((skillId) => {
                const skill = skills[skillId]
                if (!skill) return null
                return (
                  <div key={skillId} className="flex items-center gap-2.5 py-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-accent-bright/40 shrink-0" />
                    <span className="text-[12px] text-text-2 truncate">{skill.name}</span>
                  </div>
                )
              })}
            </div>
          )}

          <div className="px-3 py-2 border-t border-white/[0.04] bg-white/[0.02]">
            <p className="text-[10px] text-text-3/70">Changes apply to the next message</p>
          </div>
        </div>
      )}
    </div>
  )
}
