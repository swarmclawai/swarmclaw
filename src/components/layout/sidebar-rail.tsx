'use client'

import { useState } from 'react'
import { usePathname } from 'next/navigation'
import { useAppStore } from '@/stores/use-app-store'
import { Avatar } from '@/components/shared/avatar'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { DaemonIndicator } from '@/components/layout/daemon-indicator'
import { NotificationCenter } from '@/components/shared/notification-center'
import { NavItem, RailTooltip } from '@/components/layout/nav-item'
import { FULL_WIDTH_VIEWS } from '@/lib/app/view-constants'
import { pathToView, useNavigate } from '@/lib/app/navigation'
import { safeStorageGet, safeStorageSet } from '@/lib/app/safe-storage'
import type { AppView } from '@/types'

const RAIL_EXPANDED_KEY = 'sc_rail_expanded'
const GITHUB_REPO_URL = 'https://github.com/swarmclawai/swarmclaw'

export function SidebarRail({
  onSwitchUser,
  isViewEnabled,
  mobile,
}: {
  onSwitchUser: () => void
  isViewEnabled: (view: AppView) => boolean
  mobile?: boolean
}) {
  const pathname = usePathname()
  const navigateTo = useNavigate()
  const currentUser = useAppStore((s) => s.currentUser)
  const appSettings = useAppStore((s) => s.appSettings)
  const agents = useAppStore((s) => s.agents)
  const currentAgentId = useAppStore((s) => s.currentAgentId)
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen)

  const activeView = pathToView(pathname) ?? 'home'

  const defaultAgent = appSettings.defaultAgentId && agents[appSettings.defaultAgentId]
    ? agents[appSettings.defaultAgentId]
    : Object.values(agents)[0] || null
  const defaultAgentId = defaultAgent?.id || null
  const isDefaultChat = activeView === 'agents' && currentAgentId === defaultAgentId

  const [railExpandedStored, setRailExpandedStored] = useState(() => {
    const stored = safeStorageGet(RAIL_EXPANDED_KEY)
    return stored === null ? true : stored === 'true'
  })
  // Mobile always forces expanded
  const railExpanded = mobile || railExpandedStored

  const toggleRail = () => {
    if (mobile) return
    const next = !railExpandedStored
    setRailExpandedStored(next)
    safeStorageSet(RAIL_EXPANDED_KEY, String(next))
  }

  const goToDefaultChat = () => {
    navigateTo('agents', defaultAgentId)
    setSidebarOpen(false)
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('swarmclaw:scroll-bottom'))
    }
  }

  const handleNavClick = (view: AppView) => {
    if (!isViewEnabled(view)) return
    if (mobile) {
      // On mobile, close the drawer on every navigation
      setSidebarOpen(false)
      return
    }
    if (FULL_WIDTH_VIEWS.has(view)) {
      setSidebarOpen(false)
    } else if (activeView === view && sidebarOpen) {
      setSidebarOpen(false)
    } else {
      setSidebarOpen(true)
    }
  }

  const isNavActive = (view: AppView) => activeView === view && (mobile || sidebarOpen || FULL_WIDTH_VIEWS.has(view))

  return (
    <div
      className={`shrink-0 bg-raised border-r border-white/[0.04] flex flex-col py-4 min-h-0 transition-all duration-300 overflow-visible ${mobile ? 'w-full' : ''}`}
      style={mobile ? undefined : { width: railExpanded ? 180 : 60, transitionTimingFunction: 'var(--ease-spring)' }}
    >
      {/* Logo + collapse toggle */}
      <div className={`flex items-center mb-4 shrink-0 ${railExpanded ? 'px-4 gap-3' : 'justify-center'}`}>
        <div className="w-10 h-10 rounded-[11px] bg-gradient-to-br from-[#4338CA] to-[#6366F1] flex items-center justify-center shrink-0
          shadow-[0_2px_12px_rgba(99,102,241,0.2)]">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="text-white">
            <path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z" fill="currentColor" />
          </svg>
        </div>
        {railExpanded && !mobile && (
          <button
            onClick={toggleRail}
            className="ml-auto w-7 h-7 rounded-[8px] flex items-center justify-center text-text-3 hover:text-text hover:bg-white/[0.04] transition-all cursor-pointer bg-transparent border-none"
            title="Collapse sidebar"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <polyline points="11 17 6 12 11 7" />
              <polyline points="18 17 13 12 18 7" />
            </svg>
          </button>
        )}
      </div>

      {/* Expand button when collapsed */}
      {!railExpanded && !mobile && (
        <div className="flex justify-center mb-2">
          <button onClick={toggleRail} className="rail-btn" title="Expand sidebar">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <polyline points="13 17 18 12 13 7" />
              <polyline points="6 17 11 12 6 7" />
            </svg>
          </button>
        </div>
      )}

      {/* Default agent shortcut */}
      {railExpanded ? (
        <div className="px-3 mb-2.5">
          <button
            onClick={goToDefaultChat}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-[12px] text-[13px] font-600 cursor-pointer transition-all text-left
              ${isDefaultChat
                ? 'bg-accent-bright/15 border border-[#6366F1]/25 text-accent-bright'
                : 'bg-accent-bright/10 border border-[#6366F1]/20 text-accent-bright hover:bg-accent-bright/15'}`}
            style={{ fontFamily: 'inherit' }}
          >
            {defaultAgent ? (
              <AgentAvatar seed={defaultAgent.avatarSeed || null} avatarUrl={defaultAgent.avatarUrl} name={defaultAgent.name} size={28} />
            ) : (
              <div className="w-7 h-7 rounded-full bg-accent-bright/15 flex items-center justify-center shrink-0">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </div>
            )}
            <div className="min-w-0">
              <div className="truncate">{defaultAgent?.name || 'Choose Agent'}</div>
              <div className="text-[10px] font-500 text-accent-bright/75 mt-0.5">
                {defaultAgent ? 'Default shortcut' : 'Pick an agent to open its thread'}
              </div>
            </div>
          </button>
        </div>
      ) : (
        <RailTooltip
          label={defaultAgent?.name || 'Choose Agent'}
          description={defaultAgent ? 'Open your default agent shortcut chat' : 'Choose an agent thread'}
        >
          <button onClick={goToDefaultChat} className={`rail-btn self-center mb-2 ${isDefaultChat ? 'active' : ''}`}>
            {defaultAgent ? (
              <AgentAvatar seed={defaultAgent.avatarSeed || null} avatarUrl={defaultAgent.avatarUrl} name={defaultAgent.name} size={20} />
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            )}
          </button>
        </RailTooltip>
      )}

      {/* Search */}
      {railExpanded ? (
        <div className="px-3 mb-2">
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('swarmclaw:open-search'))}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-[13px] font-500 cursor-pointer transition-all
              bg-transparent text-text-3 hover:text-text hover:bg-white/[0.04] border-none"
            style={{ fontFamily: 'inherit' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            Search
            <kbd className="ml-auto px-1.5 py-0.5 rounded-[5px] bg-white/[0.06] border border-white/[0.08] text-[10px] font-mono text-text-3">
              ⌘K
            </kbd>
          </button>
        </div>
      ) : (
        <RailTooltip label="Search" description="Search across all entities (⌘K)">
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('swarmclaw:open-search'))}
            className="rail-btn self-center mb-2"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>
        </RailTooltip>
      )}

      <div className="flex-1 min-h-0 flex flex-col overflow-y-auto overscroll-contain touch-pan-y">
        {/* Nav items */}
        <div className={`flex flex-col gap-3 ${railExpanded ? 'px-3' : 'items-center'}`}>
          <div className={`flex flex-col gap-0.5 ${railExpanded ? '' : 'items-center'}`}>
            {railExpanded ? (
              <div className="px-3 pb-1 text-[10px] font-700 uppercase tracking-[0.12em] text-text-3/45">Workspace</div>
            ) : (
              <div className="my-1 h-px w-6 bg-white/[0.06]" />
            )}
            <NavItem view="home" label="Home" expanded={railExpanded} isActive={isNavActive('home')} onClick={() => handleNavClick('home')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" />
              </svg>
            </NavItem>
            <NavItem view="agents" label="Agents" expanded={railExpanded} isActive={isNavActive('agents')} onClick={() => handleNavClick('agents')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
              </svg>
            </NavItem>
            {isViewEnabled('inbox') && (
              <NavItem view="inbox" label="Inbox" expanded={railExpanded} isActive={isNavActive('inbox')} onClick={() => handleNavClick('inbox')}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 12h-5l-2 3H9l-2-3H2" />
                  <path d="M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
                </svg>
              </NavItem>
            )}
            {isViewEnabled('chatrooms') && (
              <NavItem view="chatrooms" label="Chatrooms" expanded={railExpanded} isActive={isNavActive('chatrooms')} onClick={() => handleNavClick('chatrooms')}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  <path d="M8 10h8" /><path d="M8 14h4" />
                </svg>
              </NavItem>
            )}
            {isViewEnabled('projects') && (
              <NavItem view="projects" label="Projects" expanded={railExpanded} isActive={isNavActive('projects')} onClick={() => handleNavClick('projects')}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M2 20a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8l-7-7H4a2 2 0 0 0-2 2v17Z" /><path d="M14 2v7h7" />
                </svg>
              </NavItem>
            )}
          </div>

          <div className={`flex flex-col gap-0.5 ${railExpanded ? '' : 'items-center'}`}>
            {railExpanded ? (
              <div className="px-3 pb-1 text-[10px] font-700 uppercase tracking-[0.12em] text-text-3/45">Execution</div>
            ) : (
              <div className="my-1 h-px w-6 bg-white/[0.06]" />
            )}
            {isViewEnabled('tasks') && (
              <NavItem view="tasks" label="Tasks" expanded={railExpanded} isActive={isNavActive('tasks')} onClick={() => handleNavClick('tasks')}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" /><rect x="9" y="3" width="6" height="4" rx="1" /><path d="M9 14l2 2 4-4" />
                </svg>
              </NavItem>
            )}
            {isViewEnabled('schedules') && (
              <NavItem view="schedules" label="Schedules" expanded={railExpanded} isActive={isNavActive('schedules')} onClick={() => handleNavClick('schedules')}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
                </svg>
              </NavItem>
            )}
            {isViewEnabled('memory') && (
              <NavItem view="memory" label="Memory" expanded={railExpanded} isActive={isNavActive('memory')} onClick={() => handleNavClick('memory')}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
                </svg>
              </NavItem>
            )}
            <NavItem view="runs" label="Runs" expanded={railExpanded} isActive={isNavActive('runs')} onClick={() => handleNavClick('runs')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
              </svg>
            </NavItem>
          </div>

          <div className={`flex flex-col gap-0.5 ${railExpanded ? '' : 'items-center'}`}>
            {railExpanded ? (
              <div className="px-3 pb-1 text-[10px] font-700 uppercase tracking-[0.12em] text-text-3/45">Knowledge</div>
            ) : (
              <div className="my-1 h-px w-6 bg-white/[0.06]" />
            )}
            <NavItem view="knowledge" label="Knowledge" expanded={railExpanded} isActive={isNavActive('knowledge')} onClick={() => handleNavClick('knowledge')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
            </NavItem>
            <NavItem view="skills" label="Skills" expanded={railExpanded} isActive={isNavActive('skills')} onClick={() => handleNavClick('skills')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
              </svg>
            </NavItem>
            {isViewEnabled('connectors') && (
              <NavItem view="connectors" label="Connectors" expanded={railExpanded} isActive={isNavActive('connectors')} onClick={() => handleNavClick('connectors')}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M15 7h3a5 5 0 0 1 5 5 5 5 0 0 1-5 5h-3m-6 0H6a5 5 0 0 1-5-5 5 5 0 0 1 5-5h3" /><line x1="8" y1="12" x2="16" y2="12" />
                </svg>
              </NavItem>
            )}
            {isViewEnabled('webhooks') && (
              <NavItem view="webhooks" label="Webhooks" expanded={railExpanded} isActive={isNavActive('webhooks')} onClick={() => handleNavClick('webhooks')}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M22 12h-4l-3 7L9 5l-3 7H2" />
                </svg>
              </NavItem>
            )}
            <NavItem view="mcp_servers" label="MCP Servers" expanded={railExpanded} isActive={isNavActive('mcp_servers')} onClick={() => handleNavClick('mcp_servers')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <rect x="2" y="2" width="20" height="8" rx="2" /><rect x="2" y="14" width="20" height="8" rx="2" /><line x1="6" y1="6" x2="6.01" y2="6" /><line x1="6" y1="18" x2="6.01" y2="18" />
              </svg>
            </NavItem>
            <NavItem view="plugins" label="Plugins" expanded={railExpanded} isActive={isNavActive('plugins')} onClick={() => handleNavClick('plugins')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2v4m0 12v4M2 12h4m12 0h4" /><circle cx="12" cy="12" r="4" /><path d="M8 8L5.5 5.5M16 8l2.5-2.5M8 16l-2.5 2.5M16 16l2.5 2.5" />
              </svg>
            </NavItem>
          </div>

          <div className={`flex flex-col gap-0.5 ${railExpanded ? '' : 'items-center'}`}>
            {railExpanded ? (
              <div className="px-3 pb-1 text-[10px] font-700 uppercase tracking-[0.12em] text-text-3/45">System</div>
            ) : (
              <div className="my-1 h-px w-6 bg-white/[0.06]" />
            )}
            <NavItem view="secrets" label="Secrets" expanded={railExpanded} isActive={isNavActive('secrets')} onClick={() => handleNavClick('secrets')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </NavItem>
            <NavItem view="providers" label="Providers" expanded={railExpanded} isActive={isNavActive('providers')} onClick={() => handleNavClick('providers')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />
              </svg>
            </NavItem>
            <NavItem view="usage" label="Usage" expanded={railExpanded} isActive={isNavActive('usage')} onClick={() => handleNavClick('usage')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
              </svg>
            </NavItem>
            <NavItem view="activity" label="Activity" expanded={railExpanded} isActive={isNavActive('activity')} onClick={() => handleNavClick('activity')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M12 8v4l3 3" /><circle cx="12" cy="12" r="10" />
              </svg>
            </NavItem>
            {isViewEnabled('wallets') && (
              <NavItem view="wallets" label="Wallets" expanded={railExpanded} isActive={isNavActive('wallets')} onClick={() => handleNavClick('wallets')}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="6" width="20" height="14" rx="2" /><path d="M22 10H18a2 2 0 0 0 0 4h4" /><path d="M6 6V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2" />
                </svg>
              </NavItem>
            )}
            {isViewEnabled('logs') && (
              <NavItem view="logs" label="Logs" expanded={railExpanded} isActive={isNavActive('logs')} onClick={() => handleNavClick('logs')}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><polyline points="10 9 9 9 8 9" />
                </svg>
              </NavItem>
            )}
          </div>
        </div>

        <div className="flex-1" />

        {/* Bottom: Docs + Daemon + Settings + User */}
        <div className={`flex flex-col gap-1 ${railExpanded ? 'px-3' : 'items-center'}`}>
          {railExpanded ? (
            <a
              href="https://swarmclaw.ai/docs"
              target="_blank"
              rel="noopener noreferrer"
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-[13px] font-500 cursor-pointer transition-all
                bg-transparent text-text-3 hover:text-text hover:bg-white/[0.04] no-underline"
              style={{ fontFamily: 'inherit' }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0">
                <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
              </svg>
              Docs
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="ml-auto opacity-40">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </a>
          ) : (
            <RailTooltip label="Docs" description="Open documentation site">
              <a href="https://swarmclaw.ai/docs" target="_blank" rel="noopener noreferrer" className="rail-btn">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
                </svg>
              </a>
            </RailTooltip>
          )}
          {railExpanded ? (
            <a
              href={GITHUB_REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-[13px] font-500 cursor-pointer transition-all
                bg-transparent text-text-3 hover:text-text hover:bg-white/[0.04] no-underline"
              style={{ fontFamily: 'inherit' }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
              </svg>
              Star on GitHub
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="ml-auto opacity-40">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </a>
          ) : (
            <RailTooltip label="Star on GitHub" description="Support SwarmClaw with a GitHub star">
              <a href={GITHUB_REPO_URL} target="_blank" rel="noopener noreferrer" className="rail-btn">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
              </a>
            </RailTooltip>
          )}
          {railExpanded && <DaemonIndicator />}
          {railExpanded ? (
            <NotificationCenter variant="row" align="left" direction="up" />
          ) : (
            <RailTooltip label="Notifications" description="View system notifications">
              <div className="rail-btn flex items-center justify-center">
                <NotificationCenter align="left" direction="up" />
              </div>
            </RailTooltip>
          )}
          <NavItem view="settings" label="Settings" expanded={railExpanded} isActive={isNavActive('settings')} onClick={() => handleNavClick('settings')}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </NavItem>

          {railExpanded ? (
            <button
              onClick={onSwitchUser}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-[10px] cursor-pointer transition-all
                bg-transparent hover:bg-white/[0.04] border-none"
              style={{ fontFamily: 'inherit' }}
            >
              <Avatar user={currentUser!} size="sm" avatarSeed={appSettings.userAvatarSeed} />
              <span className="text-[13px] font-500 text-text-2 capitalize truncate">{currentUser}</span>
            </button>
          ) : (
            <RailTooltip label="Profile" description="Edit your profile">
              <button onClick={onSwitchUser} className="mt-2 bg-transparent border-none cursor-pointer shrink-0">
                <Avatar user={currentUser!} size="sm" avatarSeed={appSettings.userAvatarSeed} />
              </button>
            </RailTooltip>
          )}
        </div>
      </div>
    </div>
  )
}
