'use client'

import { useState, useCallback, useEffect, useMemo } from 'react'
import { updateAgent } from '@/lib/agents'
import { toast } from 'sonner'
import { HintTip } from '@/components/shared/hint-tip'
import { AdvancedSettingsSection } from '@/components/shared/advanced-settings-section'
import { useAppStore } from '@/stores/use-app-store'
import type { Agent, SwarmDockMarketplaceConfig } from '@/types'

const DEFAULT_MARKETPLACE: SwarmDockMarketplaceConfig = {
  enabled: false,
  autoDiscover: false,
  maxBudgetUsdc: '5000000',
  autoBid: false,
  autoBidMaxPrice: '1000000',
  taskNotifications: true,
  preferredCategories: [],
}

export function AgentMarketplaceSettings({ agent, onUpdate }: {
  agent: Agent
  onUpdate?: (agent: Agent) => void
}) {
  const [enabled, setEnabled] = useState(agent.swarmdockEnabled || false)
  const [description, setDescription] = useState(agent.swarmdockDescription || '')
  const [skills, setSkills] = useState<string[]>(agent.swarmdockSkills || [])
  const [walletId, setWalletId] = useState<string | null>(agent.swarmdockWalletId || null)
  const [marketplace, setMarketplace] = useState<SwarmDockMarketplaceConfig>(agent.swarmdockMarketplace || DEFAULT_MARKETPLACE)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [skillInput, setSkillInput] = useState('')
  const [saving, setSaving] = useState(false)

  const wallets = useAppStore((s) => s.wallets)
  const loadWallets = useAppStore((s) => s.loadWallets)

  useEffect(() => {
    loadWallets()
  }, [loadWallets])

  const agentWallets = useMemo(() =>
    Object.values(wallets).filter((w) => w.agentId === agent.id),
  [wallets, agent.id])

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      const updated = await updateAgent(agent.id, {
        swarmdockEnabled: enabled,
        swarmdockDescription: description.trim() || null,
        swarmdockSkills: skills,
        swarmdockWalletId: walletId,
        swarmdockListedAt: enabled && !agent.swarmdockListedAt ? Date.now() : agent.swarmdockListedAt,
        swarmdockMarketplace: marketplace.enabled ? marketplace : null,
      })
      toast.success('Marketplace settings saved')
      onUpdate?.(updated)
    } catch {
      toast.error('Failed to save marketplace settings')
    } finally {
      setSaving(false)
    }
  }, [agent.id, agent.swarmdockListedAt, enabled, description, skills, walletId, marketplace, onUpdate])

  const addSkill = useCallback(() => {
    const trimmed = skillInput.trim().toLowerCase().replace(/\s+/g, '-')
    if (trimmed && !skills.includes(trimmed)) {
      setSkills((prev) => [...prev, trimmed])
    }
    setSkillInput('')
  }, [skillInput, skills])

  const removeSkill = useCallback((skill: string) => {
    setSkills((prev) => prev.filter((s) => s !== skill))
  }, [])

  const truncateAddr = (addr: string) =>
    addr.length > 12 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr

  return (
    <div className="space-y-5">
      {/* Enable/Disable toggle */}
      <div className="flex items-center justify-between gap-4 rounded-[14px] border border-white/[0.06] bg-white/[0.02] px-4 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-[14px] font-600 text-text">SwarmDock</p>
            <HintTip text="Enable this agent to list on the SwarmDock AI marketplace" />
          </div>
          <p className="mt-1 text-[12px] leading-[1.6] text-text-3/75">
            List this agent on the marketplace to accept tasks and earn USDC.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setEnabled((c) => !c)}
          className={`relative h-6 w-11 shrink-0 rounded-full border-none transition-colors duration-200 ${enabled ? 'bg-accent-bright' : 'bg-white/[0.12]'}`}
          aria-pressed={enabled}
        >
          <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform duration-200 ${enabled ? 'translate-x-5' : 'translate-x-0'}`} />
        </button>
      </div>

      {enabled && (
        <>
          {/* Description */}
          <div>
            <label className="flex items-center gap-2 text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
              Marketplace Description <HintTip text="A short description shown on the agent's marketplace profile" />
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe what this agent specializes in..."
              className="w-full min-h-[80px] px-4 py-3 rounded-[14px] border border-white/[0.08] bg-surface text-text text-[14px] outline-none transition-all placeholder:text-text-3/50 focus-glow resize-y"
              style={{ fontFamily: 'inherit' }}
              maxLength={500}
            />
          </div>

          {/* Skills */}
          <div>
            <label className="flex items-center gap-2 text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
              Skills <HintTip text="Skill tags for task matching on the marketplace" />
            </label>
            {skills.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2">
                {skills.map((skill) => (
                  <button
                    key={skill}
                    onClick={() => removeSkill(skill)}
                    className="px-3 py-1.5 rounded-[10px] border border-accent-bright/40 bg-accent-bright/10 text-accent-bright text-[12px] font-500 transition-all cursor-pointer bg-transparent hover:bg-red-500/10 hover:border-red-500/40 hover:text-red-400"
                  >
                    {skill} &times;
                  </button>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <input
                value={skillInput}
                onChange={(e) => setSkillInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSkill() } }}
                placeholder="e.g. data-analysis, web-design"
                className="flex-1 px-4 py-2.5 rounded-[14px] border border-white/[0.08] bg-surface text-text text-[14px] outline-none transition-all placeholder:text-text-3/50 focus-glow"
                style={{ fontFamily: 'inherit' }}
              />
              <button
                type="button"
                onClick={addSkill}
                disabled={!skillInput.trim()}
                className="px-4 py-2.5 rounded-[12px] border border-white/[0.08] bg-white/[0.04] text-text-2 text-[13px] font-500 transition-all hover:bg-white/[0.08] disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
              >
                Add
              </button>
            </div>
          </div>

          {/* Wallet picker */}
          <div>
            <label className="flex items-center gap-2 text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
              Payout Wallet <HintTip text="Base L2 wallet for receiving USDC payments" />
            </label>
            {agentWallets.length > 0 ? (
              <select
                value={walletId || ''}
                onChange={(e) => setWalletId(e.target.value || null)}
                className="w-full px-4 py-3 rounded-[14px] border border-white/[0.08] bg-surface text-text text-[14px] outline-none cursor-pointer"
                style={{ fontFamily: 'inherit' }}
              >
                <option value="">No wallet selected</option>
                {agentWallets.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.label ? `${w.label} (${truncateAddr(w.walletAddress)})` : truncateAddr(w.walletAddress)}
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-[13px] text-text-3/75">
                No wallets linked to this agent. Add a wallet in the Wallets section first.
              </p>
            )}
          </div>

          {/* Advanced: Marketplace config */}
          <AdvancedSettingsSection
            open={showAdvanced}
            onToggle={() => setShowAdvanced((c) => !c)}
            summary={marketplace.enabled ? 'Active' : undefined}
            badges={marketplace.enabled ? [
              ...(marketplace.autoDiscover ? ['auto-discover'] : []),
              ...(marketplace.autoBid ? ['auto-bid'] : []),
            ] : []}
          >
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-[13px] font-600 text-text">Marketplace Automation</p>
                    <HintTip text="Enable automated task discovery and bidding on the marketplace" />
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setMarketplace((m) => ({ ...m, enabled: !m.enabled }))}
                  className={`relative h-6 w-11 shrink-0 rounded-full border-none transition-colors duration-200 ${marketplace.enabled ? 'bg-accent-bright' : 'bg-white/[0.12]'}`}
                  aria-pressed={marketplace.enabled}
                >
                  <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform duration-200 ${marketplace.enabled ? 'translate-x-5' : 'translate-x-0'}`} />
                </button>
              </div>

              {marketplace.enabled && (
                <>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <div
                      onClick={() => setMarketplace((m) => ({ ...m, autoDiscover: !m.autoDiscover }))}
                      className={`w-11 h-6 rounded-full transition-all duration-200 relative cursor-pointer shrink-0 ${marketplace.autoDiscover ? 'bg-accent-bright' : 'bg-white/[0.08]'}`}
                    >
                      <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200 ${marketplace.autoDiscover ? 'left-[22px]' : 'left-0.5'}`} />
                    </div>
                    <span className="flex items-center gap-2 text-[13px] text-text-2">
                      Auto-discover <HintTip text="Automatically scan for matching tasks" />
                    </span>
                  </label>

                  <label className="flex items-center gap-3 cursor-pointer">
                    <div
                      onClick={() => setMarketplace((m) => ({ ...m, autoBid: !m.autoBid }))}
                      className={`w-11 h-6 rounded-full transition-all duration-200 relative cursor-pointer shrink-0 ${marketplace.autoBid ? 'bg-accent-bright' : 'bg-white/[0.08]'}`}
                    >
                      <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200 ${marketplace.autoBid ? 'left-[22px]' : 'left-0.5'}`} />
                    </div>
                    <span className="flex items-center gap-2 text-[13px] text-text-2">
                      Auto-bid <HintTip text="Automatically bid on matching tasks" />
                    </span>
                  </label>

                  <label className="flex items-center gap-3 cursor-pointer">
                    <div
                      onClick={() => setMarketplace((m) => ({ ...m, taskNotifications: !m.taskNotifications }))}
                      className={`w-11 h-6 rounded-full transition-all duration-200 relative cursor-pointer shrink-0 ${marketplace.taskNotifications ? 'bg-accent-bright' : 'bg-white/[0.08]'}`}
                    >
                      <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200 ${marketplace.taskNotifications ? 'left-[22px]' : 'left-0.5'}`} />
                    </div>
                    <span className="flex items-center gap-2 text-[13px] text-text-2">
                      Task notifications <HintTip text="Show notifications for new matching tasks" />
                    </span>
                  </label>

                  <div>
                    <label className="flex items-center gap-2 text-[12px] font-600 text-text-2 mb-1.5">
                      Max budget (USDC) <HintTip text="Maximum budget cap per task. 1000000 = $1.00" />
                    </label>
                    <input
                      value={marketplace.maxBudgetUsdc}
                      onChange={(e) => setMarketplace((m) => ({ ...m, maxBudgetUsdc: e.target.value.replace(/[^0-9]/g, '') }))}
                      placeholder="5000000"
                      className="w-full px-4 py-3 rounded-[14px] border border-white/[0.08] bg-surface text-text text-[14px] outline-none transition-all placeholder:text-text-3/50 focus-glow"
                      style={{ fontFamily: 'inherit' }}
                    />
                    <p className="mt-1 text-[11px] text-text-3/60">
                      = ${(parseInt(marketplace.maxBudgetUsdc || '0', 10) / 1_000_000).toFixed(2)} USDC
                    </p>
                  </div>

                  {marketplace.autoBid && (
                    <div>
                      <label className="flex items-center gap-2 text-[12px] font-600 text-text-2 mb-1.5">
                        Auto-bid max price (USDC) <HintTip text="Maximum amount to auto-bid per task. 1000000 = $1.00" />
                      </label>
                      <input
                        value={marketplace.autoBidMaxPrice}
                        onChange={(e) => setMarketplace((m) => ({ ...m, autoBidMaxPrice: e.target.value.replace(/[^0-9]/g, '') }))}
                        placeholder="1000000"
                        className="w-full px-4 py-3 rounded-[14px] border border-white/[0.08] bg-surface text-text text-[14px] outline-none transition-all placeholder:text-text-3/50 focus-glow"
                        style={{ fontFamily: 'inherit' }}
                      />
                      <p className="mt-1 text-[11px] text-text-3/60">
                        = ${(parseInt(marketplace.autoBidMaxPrice || '0', 10) / 1_000_000).toFixed(2)} USDC
                      </p>
                    </div>
                  )}
                </>
              )}
            </div>
          </AdvancedSettingsSection>
        </>
      )}

      {/* Save button */}
      <div className="flex justify-end pt-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-6 py-2.5 rounded-[12px] bg-accent-bright text-white text-[14px] font-600 transition-all
            hover:bg-accent-bright/90 disabled:opacity-40 disabled:cursor-not-allowed border-none cursor-pointer"
        >
          {saving ? 'Saving...' : 'Save Marketplace Settings'}
        </button>
      </div>
    </div>
  )
}
