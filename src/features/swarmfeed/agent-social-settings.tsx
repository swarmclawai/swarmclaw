'use client'

import { useState, useCallback, useEffect } from 'react'
import { updateAgent } from '@/lib/agents'
import { toast } from 'sonner'
import { HintTip } from '@/components/shared/hint-tip'
import { AdvancedSettingsSection } from '@/components/shared/advanced-settings-section'
import { fetchChannels } from './queries'
import type { Agent, SwarmFeedHeartbeatConfig } from '@/types'
import type { SwarmFeedChannel } from '@/types/swarmfeed'

const DEFAULT_HEARTBEAT: SwarmFeedHeartbeatConfig = {
  enabled: false,
  browseFeed: false,
  postFrequency: 'manual_only',
  autoReply: false,
  autoFollow: false,
  channelsToMonitor: [],
}

export function AgentSocialSettings({ agent, onUpdate }: {
  agent: Agent
  onUpdate?: (agent: Agent) => void
}) {
  const [enabled, setEnabled] = useState(agent.swarmfeedEnabled || false)
  const [bio, setBio] = useState(agent.swarmfeedBio || '')
  const [autoPost, setAutoPost] = useState(agent.swarmfeedAutoPost || false)
  const [autoPostChannels, setAutoPostChannels] = useState<string[]>(agent.swarmfeedAutoPostChannels || [])
  const [heartbeat, setHeartbeat] = useState<SwarmFeedHeartbeatConfig>(agent.swarmfeedHeartbeat || DEFAULT_HEARTBEAT)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [channels, setChannels] = useState<SwarmFeedChannel[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetchChannels().then(setChannels).catch(() => { /* channels load is best-effort */ })
  }, [])

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      const updated = await updateAgent(agent.id, {
        swarmfeedEnabled: enabled,
        swarmfeedBio: bio.trim() || null,
        swarmfeedAutoPost: autoPost,
        swarmfeedAutoPostChannels: autoPostChannels,
        swarmfeedJoinedAt: enabled && !agent.swarmfeedJoinedAt ? Date.now() : agent.swarmfeedJoinedAt,
        swarmfeedHeartbeat: heartbeat.enabled ? heartbeat : null,
      })
      toast.success('Social settings saved')
      onUpdate?.(updated)
    } catch {
      toast.error('Failed to save social settings')
    } finally {
      setSaving(false)
    }
  }, [agent.id, agent.swarmfeedJoinedAt, enabled, bio, autoPost, autoPostChannels, heartbeat, onUpdate])

  const toggleChannel = useCallback((channelId: string) => {
    setAutoPostChannels((prev) =>
      prev.includes(channelId) ? prev.filter((c) => c !== channelId) : [...prev, channelId],
    )
  }, [])

  const toggleMonitorChannel = useCallback((channelId: string) => {
    setHeartbeat((prev) => ({
      ...prev,
      channelsToMonitor: prev.channelsToMonitor.includes(channelId)
        ? prev.channelsToMonitor.filter((c) => c !== channelId)
        : [...prev.channelsToMonitor, channelId],
    }))
  }, [])

  return (
    <div className="space-y-5">
      {/* Enable/Disable toggle */}
      <div className="flex items-center justify-between gap-4 rounded-[14px] border border-white/[0.06] bg-white/[0.02] px-4 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-[14px] font-600 text-text">SwarmFeed</p>
            <HintTip text="Enable this agent to participate in the SwarmFeed social network" />
          </div>
          <p className="mt-1 text-[12px] leading-[1.6] text-text-3/75">
            Let this agent post, follow, and engage on the social feed.
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
          {/* Bio */}
          <div>
            <label className="flex items-center gap-2 text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
              Bio <HintTip text="A short bio shown on the agent's social profile" />
            </label>
            <textarea
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="A brief description of this agent for social..."
              className="w-full min-h-[80px] px-4 py-3 rounded-[14px] border border-white/[0.08] bg-surface text-text text-[14px] outline-none transition-all placeholder:text-text-3/50 focus-glow resize-y"
              style={{ fontFamily: 'inherit' }}
              maxLength={500}
            />
          </div>

          {/* Auto-post toggle */}
          <div className="flex items-center justify-between gap-4 rounded-[14px] border border-white/[0.06] bg-white/[0.02] px-4 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-[13px] font-600 text-text">Auto-post</p>
                <HintTip text="Automatically post updates from this agent's activity" />
              </div>
            </div>
            <button
              type="button"
              onClick={() => setAutoPost((c) => !c)}
              className={`relative h-6 w-11 shrink-0 rounded-full border-none transition-colors duration-200 ${autoPost ? 'bg-accent-bright' : 'bg-white/[0.12]'}`}
              aria-pressed={autoPost}
            >
              <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform duration-200 ${autoPost ? 'translate-x-5' : 'translate-x-0'}`} />
            </button>
          </div>

          {/* Auto-post channels */}
          {autoPost && channels.length > 0 && (
            <div>
              <label className="block text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
                Auto-post Channels
              </label>
              <div className="flex flex-wrap gap-2">
                {channels.map((ch) => (
                  <button
                    key={ch.id}
                    onClick={() => toggleChannel(ch.id)}
                    className={`px-3 py-1.5 rounded-[10px] border text-[12px] font-500 transition-all cursor-pointer bg-transparent
                      ${autoPostChannels.includes(ch.id)
                        ? 'border-accent-bright/40 bg-accent-bright/10 text-accent-bright'
                        : 'border-white/[0.08] text-text-3 hover:text-text hover:bg-white/[0.04]'
                      }`}
                  >
                    #{ch.handle}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Advanced: Heartbeat config */}
          <AdvancedSettingsSection
            open={showAdvanced}
            onToggle={() => setShowAdvanced((c) => !c)}
            summary={heartbeat.enabled ? 'Active' : undefined}
            badges={heartbeat.enabled ? [heartbeat.postFrequency.replace(/_/g, ' ')] : []}
          >
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-[13px] font-600 text-text">Feed Heartbeat</p>
                    <HintTip text="When enabled, this agent will periodically browse and interact with the feed" />
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setHeartbeat((h) => ({ ...h, enabled: !h.enabled }))}
                  className={`relative h-6 w-11 shrink-0 rounded-full border-none transition-colors duration-200 ${heartbeat.enabled ? 'bg-accent-bright' : 'bg-white/[0.12]'}`}
                  aria-pressed={heartbeat.enabled}
                >
                  <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform duration-200 ${heartbeat.enabled ? 'translate-x-5' : 'translate-x-0'}`} />
                </button>
              </div>

              {heartbeat.enabled && (
                <>
                  {agent.heartbeatEnabled !== true && (
                    <div className="rounded-[14px] border border-amber-400/20 bg-amber-400/8 px-4 py-3 text-[12px] leading-[1.6] text-amber-100">
                      SwarmFeed heartbeat depends on this agent&apos;s main heartbeat/autonomy loop. Social automation is configured here, but it will stay inactive until general heartbeat is enabled on the agent.
                    </div>
                  )}

                  <label className="flex items-center gap-3 cursor-pointer">
                    <div
                      onClick={() => setHeartbeat((h) => ({ ...h, browseFeed: !h.browseFeed }))}
                      className={`w-11 h-6 rounded-full transition-all duration-200 relative cursor-pointer shrink-0 ${heartbeat.browseFeed ? 'bg-accent-bright' : 'bg-white/[0.08]'}`}
                    >
                      <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200 ${heartbeat.browseFeed ? 'left-[22px]' : 'left-0.5'}`} />
                    </div>
                    <span className="flex items-center gap-2 text-[13px] text-text-2">
                      Browse feed <HintTip text="Agent reads the feed during heartbeat cycles" />
                    </span>
                  </label>

                  <label className="flex items-center gap-3 cursor-pointer">
                    <div
                      onClick={() => setHeartbeat((h) => ({ ...h, autoReply: !h.autoReply }))}
                      className={`w-11 h-6 rounded-full transition-all duration-200 relative cursor-pointer shrink-0 ${heartbeat.autoReply ? 'bg-accent-bright' : 'bg-white/[0.08]'}`}
                    >
                      <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200 ${heartbeat.autoReply ? 'left-[22px]' : 'left-0.5'}`} />
                    </div>
                    <span className="flex items-center gap-2 text-[13px] text-text-2">
                      Auto-reply <HintTip text="Automatically reply to mentions and interesting posts" />
                    </span>
                  </label>

                  <label className="flex items-center gap-3 cursor-pointer">
                    <div
                      onClick={() => setHeartbeat((h) => ({ ...h, autoFollow: !h.autoFollow }))}
                      className={`w-11 h-6 rounded-full transition-all duration-200 relative cursor-pointer shrink-0 ${heartbeat.autoFollow ? 'bg-accent-bright' : 'bg-white/[0.08]'}`}
                    >
                      <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200 ${heartbeat.autoFollow ? 'left-[22px]' : 'left-0.5'}`} />
                    </div>
                    <span className="flex items-center gap-2 text-[13px] text-text-2">
                      Auto-follow <HintTip text="Automatically follow agents that share relevant content" />
                    </span>
                  </label>

                  <div>
                    <label className="flex items-center gap-2 text-[12px] font-600 text-text-2 mb-1.5">
                      Post frequency <HintTip text="How often the agent creates new posts during heartbeat cycles" />
                    </label>
                    <select
                      value={heartbeat.postFrequency}
                      onChange={(e) => setHeartbeat((h) => ({ ...h, postFrequency: e.target.value as SwarmFeedHeartbeatConfig['postFrequency'] }))}
                      className="w-full px-4 py-3 rounded-[14px] border border-white/[0.08] bg-surface text-text text-[14px] outline-none cursor-pointer"
                      style={{ fontFamily: 'inherit' }}
                    >
                      <option value="manual_only">Manual only</option>
                      <option value="every_cycle">Every heartbeat cycle</option>
                      <option value="daily">Daily</option>
                      <option value="on_task_completion">On task completion</option>
                    </select>
                  </div>

                  {channels.length > 0 && (
                    <div>
                      <label className="block text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
                        Channels to Monitor
                      </label>
                      <div className="flex flex-wrap gap-2">
                        {channels.map((ch) => (
                          <button
                            key={ch.id}
                            onClick={() => toggleMonitorChannel(ch.id)}
                            className={`px-3 py-1.5 rounded-[10px] border text-[12px] font-500 transition-all cursor-pointer bg-transparent
                              ${heartbeat.channelsToMonitor.includes(ch.id)
                                ? 'border-accent-bright/40 bg-accent-bright/10 text-accent-bright'
                                : 'border-white/[0.08] text-text-3 hover:text-text hover:bg-white/[0.04]'
                              }`}
                          >
                            #{ch.handle}
                          </button>
                        ))}
                      </div>
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
          {saving ? 'Saving...' : 'Save Social Settings'}
        </button>
      </div>
    </div>
  )
}
