'use client'

import { useEffect, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { ClawHubBrowser } from './clawhub-browser'

export function SkillList({ inSidebar }: { inSidebar?: boolean }) {
  const skills = useAppStore((s) => s.skills)
  const loadSkills = useAppStore((s) => s.loadSkills)
  const setSkillSheetOpen = useAppStore((s) => s.setSkillSheetOpen)
  const setEditingSkillId = useAppStore((s) => s.setEditingSkillId)
  const [clawHubOpen, setClawHubOpen] = useState(false)

  useEffect(() => {
    loadSkills()
  }, [])

  const skillList = Object.values(skills)

  const handleEdit = (id: string) => {
    setEditingSkillId(id)
    setSkillSheetOpen(true)
  }

  return (
    <div className={`flex-1 overflow-y-auto ${inSidebar ? 'px-3 pb-4' : 'px-4'}`}>
      <button
        onClick={() => setClawHubOpen(true)}
        className="w-full mb-3 py-2.5 px-4 rounded-[12px] border border-dashed border-white/[0.1] text-[13px] font-600 text-text-3 hover:text-accent-bright hover:border-accent-bright/30 transition-all cursor-pointer bg-transparent"
        style={{ fontFamily: 'inherit' }}
      >
        Browse ClawHub Skills
      </button>
      <ClawHubBrowser open={clawHubOpen} onOpenChange={setClawHubOpen} onInstalled={() => loadSkills()} />
      {skillList.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-[13px] text-text-3/60">No skills yet</p>
          <button
            onClick={() => setSkillSheetOpen(true)}
            className="mt-3 px-4 py-2 rounded-[10px] bg-transparent text-accent-bright text-[13px] font-600 cursor-pointer border border-accent-bright/20 hover:bg-accent-soft transition-all"
            style={{ fontFamily: 'inherit' }}
          >
            + Add Skill
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {skillList.map((skill) => (
            <button
              key={skill.id}
              onClick={() => handleEdit(skill.id)}
              className="w-full text-left p-4 rounded-[14px] border border-white/[0.06] bg-surface hover:bg-surface-2 transition-all cursor-pointer"
            >
              <div className="flex items-center justify-between mb-1">
                <span className="font-display text-[14px] font-600 text-text truncate">{skill.name}</span>
                <span className="text-[10px] font-mono text-text-3/50 shrink-0 ml-2">{skill.filename}</span>
              </div>
              {skill.description && (
                <p className="text-[12px] text-text-3/60 line-clamp-2">{skill.description}</p>
              )}
              <div className="text-[11px] text-text-3/70 mt-1.5">
                {skill.content.length} chars
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
