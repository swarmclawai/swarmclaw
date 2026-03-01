'use client'

import { useCallback, useEffect, useState } from 'react'
import type { OpenClawSkillEntry, SkillAllowlistMode } from '@/types'
import { api } from '@/lib/api-client'
import { SkillInstallDialog } from './skill-install-dialog'
import { ConfirmDialog } from '@/components/shared/confirm-dialog'

interface Props {
  agentId: string
  initialMode?: SkillAllowlistMode
  initialAllowed?: string[]
}

const SOURCE_ORDER: OpenClawSkillEntry['source'][] = ['bundled', 'managed', 'personal', 'workspace']

export function OpenClawSkillsPanel({ agentId, initialMode = 'all', initialAllowed = [] }: Props) {
  const [skills, setSkills] = useState<OpenClawSkillEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<SkillAllowlistMode>(initialMode)
  const [allowed, setAllowed] = useState<Set<string>>(new Set(initialAllowed))
  const [saving, setSaving] = useState(false)
  const [installTarget, setInstallTarget] = useState<OpenClawSkillEntry | null>(null)
  const [removeTarget, setRemoveTarget] = useState<OpenClawSkillEntry | null>(null)

  const loadSkills = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await api<OpenClawSkillEntry[]>('GET', `/openclaw/skills?agentId=${agentId}`)
      setSkills(Array.isArray(result) ? result : [])
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [agentId])

  useEffect(() => { loadSkills() }, [loadSkills])

  const handleModeChange = (newMode: SkillAllowlistMode) => {
    setMode(newMode)
  }

  const toggleSkill = (name: string) => {
    setAllowed((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await api('PUT', '/openclaw/skills', {
        agentId,
        mode,
        allowedSkills: Array.from(allowed),
      })
    } catch {
      // toast or ignore
    } finally {
      setSaving(false)
    }
  }

  const grouped = SOURCE_ORDER
    .map((source) => ({
      source,
      items: skills.filter((s) => s.source === source),
    }))
    .filter((g) => g.items.length > 0)

  if (loading) {
    return <div className="flex items-center justify-center h-32 text-[13px] text-text-3/50">Loading skills...</div>
  }

  if (error) {
    return <div className="flex items-center justify-center h-32 text-[13px] text-red-400">{error}</div>
  }

  return (
    <div className="flex flex-col gap-4 p-2">
      {/* Mode selector */}
      <div className="flex gap-1">
        {(['all', 'none', 'selected'] as const).map((m) => (
          <button
            key={m}
            onClick={() => handleModeChange(m)}
            className={`px-3 py-1.5 rounded-[8px] text-[11px] font-600 capitalize cursor-pointer transition-all
              ${mode === m ? 'bg-accent-soft text-accent-bright' : 'bg-transparent text-text-3 hover:text-text-2'}`}
            style={{ fontFamily: 'inherit' }}
          >
            {m === 'selected' ? 'Custom' : m}
          </button>
        ))}
      </div>

      {/* Skill groups */}
      {grouped.map(({ source, items }) => (
        <div key={source}>
          <h4 className="text-[11px] font-600 uppercase tracking-wider text-text-3/50 mb-2 px-1">
            {source}
          </h4>
          <div className="flex flex-col gap-1">
            {items.map((skill) => (
              <div
                key={skill.name}
                className="flex items-center gap-3 py-2 px-3 rounded-[10px] bg-white/[0.02] border border-white/[0.04]"
              >
                {mode === 'selected' && (
                  <button
                    onClick={() => toggleSkill(skill.name)}
                    className={`w-5 h-5 rounded-[5px] border-2 flex items-center justify-center shrink-0 cursor-pointer transition-all
                      ${allowed.has(skill.name)
                        ? 'bg-accent-bright border-accent-bright'
                        : 'bg-transparent border-white/[0.15] hover:border-white/[0.25]'}`}
                  >
                    {allowed.has(skill.name) && (
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </button>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-600 text-text truncate">{skill.name}</span>
                    <span className={`shrink-0 text-[9px] font-600 uppercase tracking-wider px-1.5 py-0.5 rounded-[4px]
                      ${skill.eligible
                        ? 'text-emerald-400 bg-emerald-400/[0.08]'
                        : skill.missing?.length
                          ? 'text-amber-400 bg-amber-400/[0.08]'
                          : 'text-red-400 bg-red-400/[0.08]'}`}>
                      {skill.eligible ? 'ready' : 'missing deps'}
                    </span>
                  </div>
                  {skill.description && (
                    <p className="text-[11px] text-text-3/60 mt-0.5 truncate">{skill.description}</p>
                  )}
                  {skill.missing && skill.missing.length > 0 && (
                    <p className="text-[10px] text-amber-400/60 mt-0.5">
                      Needs: {skill.missing.join(', ')}
                    </p>
                  )}
                </div>
                {/* Action buttons */}
                <div className="flex gap-1 shrink-0">
                  {!skill.eligible && skill.installOptions && skill.installOptions.length > 0 && (
                    <button
                      onClick={() => setInstallTarget(skill)}
                      className="text-[10px] text-accent-bright bg-transparent border-none cursor-pointer hover:underline"
                    >
                      Install
                    </button>
                  )}
                  {skill.skillKey && (
                    <button
                      onClick={async () => {
                        await api('PATCH', '/openclaw/skills', { skillKey: skill.skillKey, enabled: !skill.disabled })
                        loadSkills()
                      }}
                      className={`text-[10px] bg-transparent border-none cursor-pointer hover:underline ${skill.disabled ? 'text-emerald-400' : 'text-amber-400'}`}
                    >
                      {skill.disabled ? 'Enable' : 'Disable'}
                    </button>
                  )}
                  {skill.skillKey && skill.source !== 'bundled' && (
                    <button
                      onClick={() => setRemoveTarget(skill)}
                      className="text-[10px] text-red-400/70 bg-transparent border-none cursor-pointer hover:underline"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {skills.length === 0 && (
        <div className="text-[13px] text-text-3/50 text-center py-4">No skills discovered</div>
      )}

      {/* Save button */}
      <button
        onClick={handleSave}
        disabled={saving}
        className="px-4 py-1.5 rounded-[8px] border-none bg-accent-bright text-white text-[12px] font-600
          cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed transition-all hover:brightness-110 self-start"
        style={{ fontFamily: 'inherit' }}
      >
        {saving ? 'Saving...' : 'Save Configuration'}
      </button>

      {/* Install dialog */}
      {installTarget && (
        <SkillInstallDialog
          open={!!installTarget}
          onClose={() => setInstallTarget(null)}
          skillName={installTarget.name}
          installOptions={installTarget.installOptions}
          onInstalled={loadSkills}
        />
      )}

      {/* Remove confirm */}
      {removeTarget && (
        <ConfirmDialog
          open={!!removeTarget}
          title="Remove Skill"
          message={`Remove "${removeTarget.name}"? This cannot be undone.`}
          confirmLabel="Remove"
          danger
          onConfirm={async () => {
            await api('POST', '/openclaw/skills/remove', { skillKey: removeTarget.skillKey, source: removeTarget.source })
            setRemoveTarget(null)
            loadSkills()
          }}
          onCancel={() => setRemoveTarget(null)}
        />
      )}
    </div>
  )
}
