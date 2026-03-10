'use client'

import { useState } from 'react'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { useAppStore } from '@/stores/use-app-store'
import { Avatar } from '@/components/shared/avatar'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { AgentChatList } from '@/components/agents/agent-chat-list'
import { AgentList } from '@/components/agents/agent-list'
import { ScheduleList } from '@/components/schedules/schedule-list'
import { MemoryAgentList } from '@/components/memory/memory-agent-list'
import { TaskList } from '@/components/tasks/task-list'
import { SecretsList } from '@/components/secrets/secrets-list'
import { ProviderList } from '@/components/providers/provider-list'
import { SkillList } from '@/components/skills/skill-list'
import { ConnectorList } from '@/components/connectors/connector-list'
import { WebhookList } from '@/components/webhooks/webhook-list'
import { LogList } from '@/components/logs/log-list'
import { McpServerList } from '@/components/mcp-servers/mcp-server-list'
import { KnowledgeList } from '@/components/knowledge/knowledge-list'
import { PluginList } from '@/components/plugins/plugin-list'
import { RunList } from '@/components/runs/run-list'
import { VIEW_LABELS, VIEW_DESCRIPTIONS, CREATE_LABELS, FULL_WIDTH_VIEWS } from '@/lib/app/view-constants'
import { getViewPath, pathToView, useNavigate } from '@/lib/app/navigation'
import type { AppView } from '@/types'

export function MobileDrawer({
  pluginSidebarItems,
  isViewEnabled,
  onSwitchUser,
  onOpenNewSheet,
}: {
  pluginSidebarItems: Array<{ id: string; label: string; href: string }>
  isViewEnabled: (view: AppView) => boolean
  onSwitchUser: () => void
  onOpenNewSheet: () => void
}) {
  const pathname = usePathname()
  const navigateTo = useNavigate()
  const activeView = pathToView(pathname) ?? 'home'
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen)
  const currentUser = useAppStore((s) => s.currentUser)
  const appSettings = useAppStore((s) => s.appSettings)
  const agents = useAppStore((s) => s.agents)
  const currentAgentId = useAppStore((s) => s.currentAgentId)

  const defaultAgent = appSettings.defaultAgentId && agents[appSettings.defaultAgentId]
    ? agents[appSettings.defaultAgentId]
    : Object.values(agents)[0] || null
  const defaultAgentId = defaultAgent?.id || null
  const isDefaultChat = activeView === 'agents' && currentAgentId === defaultAgentId

  const [agentViewMode, setAgentViewMode] = useState<'chat' | 'config'>('chat')

  const goToDefaultChat = () => {
    navigateTo('agents', defaultAgentId)
    setSidebarOpen(false)
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('swarmclaw:scroll-bottom'))
    }
  }

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={() => setSidebarOpen(false)} />
      <div
        className="absolute inset-y-0 left-0 w-[300px] bg-raised shadow-[4px_0_60px_rgba(0,0,0,0.7)] flex flex-col min-h-0 overflow-hidden touch-pan-y"
        style={{ animation: 'slide-in-left 0.25s cubic-bezier(0.16, 1, 0.3, 1)' }}
      >
        <div className="flex items-center gap-3 px-5 py-4 shrink-0">
          <div className="w-9 h-9 rounded-[10px] bg-gradient-to-br from-[#4338CA] to-[#6366F1] flex items-center justify-center
            shadow-[0_2px_8px_rgba(99,102,241,0.15)]">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-white">
              <path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z" fill="currentColor" />
            </svg>
          </div>
          <span className="font-display text-[15px] font-600 flex-1 tracking-[-0.02em]">SwarmClaw</span>
          <a href="https://swarmclaw.ai/docs" target="_blank" rel="noopener noreferrer" className="rail-btn" title="Documentation">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
            </svg>
          </a>
          <Link
            href="/settings"
            onClick={() => setSidebarOpen(false)}
            className={`rail-btn ${activeView === 'settings' ? 'active' : ''}`}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </Link>
          <button onClick={onSwitchUser} className="bg-transparent border-none cursor-pointer shrink-0">
            <Avatar user={currentUser!} size="sm" avatarSeed={appSettings.userAvatarSeed} />
          </button>
        </div>
        {defaultAgent && (
          <div className="px-4 pt-1 pb-3 shrink-0">
            <button
              onClick={goToDefaultChat}
              className={`w-full flex items-center gap-3 rounded-[14px] border px-4 py-3 text-left transition-all cursor-pointer ${
                isDefaultChat
                  ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
                  : 'bg-accent-soft/50 border-accent-bright/15 text-accent-bright hover:bg-accent-soft/65'
              }`}
              style={{ fontFamily: 'inherit' }}
            >
              <AgentAvatar seed={defaultAgent.avatarSeed || null} avatarUrl={defaultAgent.avatarUrl} name={defaultAgent.name} size={32} />
              <div className="min-w-0">
                <div className="text-[13px] font-700 truncate">{defaultAgent.name}</div>
                <div className="text-[11px] text-accent-bright/70">Default shortcut</div>
              </div>
            </button>
          </div>
        )}
        <div className="px-4 pb-3 shrink-0 max-h-[260px] overflow-y-auto">
          <div className="space-y-4">
            {([
              { label: 'Workspace', views: ['agents', 'chatrooms', 'projects'] as AppView[] },
              { label: 'Execution', views: ['tasks', 'schedules', 'memory', 'runs'] as AppView[] },
              { label: 'Knowledge', views: ['knowledge', 'skills', 'connectors', 'webhooks', 'mcp_servers', 'plugins'] as AppView[] },
              { label: 'System', views: ['secrets', 'providers', 'usage', 'logs'] as AppView[] },
            ]).map((section) => {
              const visibleViews = section.views.filter((view) => isViewEnabled(view))
              if (!visibleViews.length) return null
              return (
                <div key={section.label}>
                  <div className="px-1 pb-2 text-[10px] font-700 uppercase tracking-[0.12em] text-text-3/45">
                    {section.label}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {visibleViews.map((view) => (
                      <Link
                        key={view}
                        href={getViewPath(view)}
                        onClick={() => {
                          if (FULL_WIDTH_VIEWS.has(view)) setSidebarOpen(false)
                        }}
                        className={`rounded-[12px] border px-3 py-2.5 text-left transition-all cursor-pointer no-underline ${
                          activeView === view
                            ? 'bg-accent-soft border-accent-bright/20 text-accent-bright'
                            : 'bg-transparent border-white/[0.06] text-text-3 hover:text-text hover:bg-white/[0.04]'
                        }`}
                        style={{ fontFamily: 'inherit' }}
                      >
                        <div className="text-[12px] font-600">{VIEW_LABELS[view]}</div>
                        <div className="text-[10px] text-current/60 mt-1">{VIEW_DESCRIPTIONS[view]}</div>
                      </Link>
                    ))}
                  </div>
                </div>
              )
            })}
            {pluginSidebarItems.length > 0 && (
              <div>
                <div className="px-1 pb-2 text-[10px] font-700 uppercase tracking-[0.12em] text-text-3/45">
                  Extensions
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {pluginSidebarItems.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => window.open(item.href, '_blank')}
                      className="rounded-[12px] border border-emerald-400/10 bg-emerald-500/[0.05] px-3 py-2.5 text-left text-emerald-400/85 hover:text-emerald-300 transition-colors cursor-pointer"
                      style={{ fontFamily: 'inherit' }}
                    >
                      <div className="text-[12px] font-600">{item.label}</div>
                      <div className="text-[10px] text-emerald-300/60 mt-1">Open plugin view</div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
        {activeView !== 'logs' && activeView !== 'usage' && activeView !== 'runs' && activeView !== 'settings' && (
          <div className="px-4 py-2.5 shrink-0">
            <button
              onClick={() => {
                setSidebarOpen(false)
                onOpenNewSheet()
              }}
              className="w-full py-3 rounded-[12px] border-none bg-accent-bright text-white text-[14px] font-600 cursor-pointer
                hover:brightness-110 active:scale-[0.98] transition-all
                shadow-[0_2px_12px_rgba(99,102,241,0.15)]"
              style={{ fontFamily: 'inherit' }}
            >
              + New {CREATE_LABELS[activeView] || 'Entry'}
            </button>
          </div>
        )}
        {activeView === 'agents' && (
          <>
            <div className="flex gap-1 px-4 pb-2">
              {(['chat', 'config'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setAgentViewMode(mode)}
                  className={`px-3 py-1.5 rounded-[8px] text-[11px] font-600 capitalize cursor-pointer transition-all
                    ${agentViewMode === mode ? 'bg-accent-soft text-accent-bright' : 'bg-transparent text-text-3 hover:text-text-2'}`}
                  style={{ fontFamily: 'inherit' }}
                >
                  {mode}
                </button>
              ))}
            </div>
            {agentViewMode === 'chat' ? <AgentChatList inSidebar onSelect={() => setSidebarOpen(false)} /> : <AgentList inSidebar />}
          </>
        )}
        {activeView === 'schedules' && <ScheduleList inSidebar />}
        {activeView === 'memory' && <MemoryAgentList />}
        {activeView === 'tasks' && <TaskList inSidebar />}
        {activeView === 'secrets' && <SecretsList inSidebar />}
        {activeView === 'providers' && <ProviderList inSidebar />}
        {activeView === 'skills' && <SkillList inSidebar />}
        {activeView === 'connectors' && <ConnectorList inSidebar />}
        {activeView === 'webhooks' && <WebhookList inSidebar />}
        {activeView === 'mcp_servers' && <McpServerList />}
        {activeView === 'knowledge' && <KnowledgeList />}
        {activeView === 'plugins' && <PluginList inSidebar />}
        {activeView === 'runs' && <RunList />}
        {activeView === 'logs' && <LogList />}
      </div>
    </div>
  )
}
