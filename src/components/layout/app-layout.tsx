'use client'

import { useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { useMediaQuery } from '@/hooks/use-media-query'
import { Avatar } from '@/components/shared/avatar'
import { WelcomeScreen } from '@/components/layout/welcome-screen'
import { SessionList } from '@/components/sessions/session-list'
import { NewSessionView } from '@/components/sessions/new-session-view'
import { AgentList } from '@/components/agents/agent-list'
import { AgentSheet } from '@/components/agents/agent-sheet'
import { ScheduleList } from '@/components/schedules/schedule-list'
import { ScheduleSheet } from '@/components/schedules/schedule-sheet'
import { SettingsView } from '@/components/settings/settings-view'
import { SettingsSidebar } from '@/components/settings/settings-sidebar'
import { MemoryList } from '@/components/memory/memory-list'
import { MemorySheet } from '@/components/memory/memory-sheet'
import { MemoryDetail } from '@/components/memory/memory-detail'
import { TaskList } from '@/components/tasks/task-list'
import { TaskSheet } from '@/components/tasks/task-sheet'
import { TaskBoard } from '@/components/tasks/task-board'
import { SecretsList } from '@/components/secrets/secrets-list'
import { SecretSheet } from '@/components/secrets/secret-sheet'
import { ProviderList } from '@/components/providers/provider-list'
import { ProviderSheet } from '@/components/providers/provider-sheet'
import { SkillList } from '@/components/skills/skill-list'
import { SkillSheet } from '@/components/skills/skill-sheet'
import { ConnectorList } from '@/components/connectors/connector-list'
import { ConnectorSheet } from '@/components/connectors/connector-sheet'
import { WebhookList } from '@/components/webhooks/webhook-list'
import { WebhookSheet } from '@/components/webhooks/webhook-sheet'
import { LogList } from '@/components/logs/log-list'
import { NetworkBanner } from './network-banner'
import { UpdateBanner } from './update-banner'
import { MobileHeader } from './mobile-header'
import { DaemonIndicator } from './daemon-indicator'
import { ChatArea } from '@/components/chat/chat-area'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { ThemeToggle } from '@/components/shared/theme-toggle'
import type { AppView } from '@/types'

const RAIL_EXPANDED_KEY = 'sc_rail_expanded'

export function AppLayout() {
  const currentUser = useAppStore((s) => s.currentUser)
  const sessions = useAppStore((s) => s.sessions)
  const currentSessionId = useAppStore((s) => s.currentSessionId)
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const newSessionOpen = useAppStore((s) => s.newSessionOpen)
  const setNewSessionOpen = useAppStore((s) => s.setNewSessionOpen)
  const setUser = useAppStore((s) => s.setUser)
  const setCurrentSession = useAppStore((s) => s.setCurrentSession)
  const activeView = useAppStore((s) => s.activeView)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const setAgentSheetOpen = useAppStore((s) => s.setAgentSheetOpen)
  const setScheduleSheetOpen = useAppStore((s) => s.setScheduleSheetOpen)
  const setTaskSheetOpen = useAppStore((s) => s.setTaskSheetOpen)
  const setSecretSheetOpen = useAppStore((s) => s.setSecretSheetOpen)
  const setProviderSheetOpen = useAppStore((s) => s.setProviderSheetOpen)
  const setSkillSheetOpen = useAppStore((s) => s.setSkillSheetOpen)
  const setConnectorSheetOpen = useAppStore((s) => s.setConnectorSheetOpen)
  const setWebhookSheetOpen = useAppStore((s) => s.setWebhookSheetOpen)
  const isDesktop = useMediaQuery('(min-width: 768px)')

  const [railExpanded, setRailExpanded] = useState(() => {
    if (typeof window === 'undefined') return true
    const stored = localStorage.getItem(RAIL_EXPANDED_KEY)
    return stored === null ? true : stored === 'true'
  })

  const toggleRail = () => {
    const next = !railExpanded
    setRailExpanded(next)
    localStorage.setItem(RAIL_EXPANDED_KEY, String(next))
  }

  const handleSwitchUser = () => {
    setUser(null)
    setCurrentSession(null)
  }

  const openNewSheet = () => {
    if (activeView === 'sessions') setNewSessionOpen(true)
    else if (activeView === 'agents') setAgentSheetOpen(true)
    else if (activeView === 'schedules') setScheduleSheetOpen(true)
    else if (activeView === 'tasks') setTaskSheetOpen(true)
    else if (activeView === 'secrets') setSecretSheetOpen(true)
    else if (activeView === 'providers') setProviderSheetOpen(true)
    else if (activeView === 'skills') setSkillSheetOpen(true)
    else if (activeView === 'connectors') setConnectorSheetOpen(true)
    else if (activeView === 'webhooks') setWebhookSheetOpen(true)
  }

  const mainSession = Object.values(sessions).find((s) => s.name === '__main__' && s.user === currentUser)

  const goToMainChat = () => {
    if (mainSession) setCurrentSession(mainSession.id)
    setActiveView('sessions')
    setSidebarOpen(false)
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('agent-ember:scroll-bottom'))
    }
  }

  return (
    <div className="h-full flex overflow-hidden">
      {/* Desktop: Navigation rail (expandable) */}
      {isDesktop && (
        <div
          className="shrink-0 bg-card border-r border-border flex flex-col py-4 transition-all duration-200 overflow-hidden"
          style={{ width: railExpanded ? 180 : 60 }}
        >
          {/* Navigation Rail Header: Branding + Collapse inline */}
          <div className={`flex flex-col mb-8 shrink-0 ${railExpanded ? 'px-3' : 'items-center border-b border-border/10 pb-4'}`}>
            <div className={`flex items-center gap-3 ${railExpanded ? '' : 'justify-center'}`}>
              <div className={`${railExpanded ? 'w-10 h-10' : 'w-8 h-8'} rounded-[10px] bg-primary flex items-center justify-center shrink-0
                shadow-[0_4px_12px_rgba(var(--primary-rgb),0.2)]`}>
                <svg width={railExpanded ? "20" : "16"} height={railExpanded ? "20" : "16"} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-white">
                  <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3 1.07.56 2 1.56 2 3a2.5 2.5 0 0 1-2.5 2.5z" />
                  <path d="M12 2c0 2.22-1 3.5-2 5.5 2.5 1 5.5 5 5.5 9.5a5.5 5.5 0 1 1-11 0c0-1.55.64-2.31 1.54-3.5a14.95 14.95 0 0 1 1.05-3c-.15.14-.35.15-.45.15-1.5 0-2.39-1.39-2.39-2.65 0-2.12 1.56-4.49 1.86-4.99L12 2z" />
                </svg>
              </div>

              {railExpanded && (
                <div className="flex flex-col min-w-0 flex-1">
                  <span className="font-display text-[10px] font-900 tracking-[0.2em] text-muted-foreground/50 uppercase leading-none mb-1">
                    Agent
                  </span>
                  <span className="font-display text-[17px] font-900 tracking-[-0.04em] text-foreground leading-none">
                    EMBER
                  </span>
                </div>
              )}

              {railExpanded && (
                <button
                  onClick={toggleRail}
                  className="w-7 h-7 rounded-md flex items-center justify-center text-muted-foreground/30 hover:text-foreground hover:bg-muted transition-all cursor-pointer bg-transparent border-none shrink-0"
                  title="Collapse sidebar"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <polyline points="11 17 6 12 11 7" />
                    <polyline points="18 17 13 12 18 7" />
                  </svg>
                </button>
              )}

              {!railExpanded && (
                <button
                  onClick={toggleRail}
                  className="rail-btn"
                  title="Expand sidebar"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <polyline points="13 17 18 12 13 7" />
                    <polyline points="6 17 11 12 6 7" />
                  </svg>
                </button>
              )}
            </div>
          </div>


          {/* Main Chat shortcut */}
          {railExpanded ? (
            <div className="px-3 mb-2">
              <button
                onClick={goToMainChat}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-[10px] text-[13px] font-600 cursor-pointer transition-all
                  ${mainSession && currentSessionId === mainSession.id && activeView === 'sessions'
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-primary/10 border border-primary/20 text-primary hover:bg-primary/20'}`}
                style={{ fontFamily: 'inherit' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                Main Chat
              </button>
            </div>
          ) : (
            <RailTooltip label="Main Chat" description="Your persistent assistant chat">
              <button
                onClick={goToMainChat}
                className={`rail-btn self-center mb-2 ${mainSession && currentSessionId === mainSession.id && activeView === 'sessions' ? 'active' : ''}`}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </button>
            </RailTooltip>
          )}

          {/* Nav items */}
          <div className={`flex flex-col gap-0.5 ${railExpanded ? 'px-3' : 'items-center'}`}>
            <NavItem view="sessions" label="Sessions" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => { setActiveView('sessions'); setSidebarOpen(true) }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
            </NavItem>
            <NavItem view="agents" label="Agents" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => { setActiveView('agents'); setSidebarOpen(true) }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
              </svg>
            </NavItem>
            <NavItem view="schedules" label="Schedules" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => { setActiveView('schedules'); setSidebarOpen(true) }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
              </svg>
            </NavItem>
            <NavItem view="memory" label="Memory" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => { setActiveView('memory'); setSidebarOpen(true) }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
              </svg>
            </NavItem>
            <NavItem view="tasks" label="Tasks" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => { setActiveView('tasks'); setSidebarOpen(true) }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" /><rect x="9" y="3" width="6" height="4" rx="1" /><path d="M9 14l2 2 4-4" />
              </svg>
            </NavItem>
            <NavItem view="secrets" label="Secrets" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => { setActiveView('secrets'); setSidebarOpen(true) }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </NavItem>
            <NavItem view="providers" label="Providers" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => { setActiveView('providers'); setSidebarOpen(true) }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />
              </svg>
            </NavItem>
            <NavItem view="skills" label="Skills" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => { setActiveView('skills'); setSidebarOpen(true) }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
              </svg>
            </NavItem>
            <NavItem view="connectors" label="Connectors" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => { setActiveView('connectors'); setSidebarOpen(true) }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M15 7h3a5 5 0 0 1 5 5 5 5 0 0 1-5 5h-3m-6 0H6a5 5 0 0 1-5-5 5 5 0 0 1 5-5h3" /><line x1="8" y1="12" x2="16" y2="12" />
              </svg>
            </NavItem>
            <NavItem view="webhooks" label="Webhooks" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => { setActiveView('webhooks'); setSidebarOpen(true) }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M22 12h-4l-3 7L9 5l-3 7H2" />
              </svg>
            </NavItem>
            <NavItem view="logs" label="Logs" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => { setActiveView('logs'); setSidebarOpen(true) }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><polyline points="10 9 9 9 8 9" />
              </svg>
            </NavItem>
          </div>

          <div className="flex-1" />

          {/* Bottom: Docs + Daemon + Settings + User */}
          <div className={`flex flex-col gap-1 ${railExpanded ? 'px-3' : 'items-center'}`}>
            {railExpanded && (
              <div className="flex flex-col gap-2 mb-2">
                <div className="px-1">
                  <ThemeToggle variant="sidebar" />
                </div>
                <DaemonIndicator />
              </div>
            )}
            {railExpanded ? (
              <a
                href="https://agent-ember.ai/docs"
                target="_blank"
                rel="noopener noreferrer"
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-[13px] font-500 cursor-pointer transition-all
                  bg-transparent text-muted-foreground hover:text-foreground hover:bg-muted no-underline"
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
                <a
                  href="https://agent-ember.ai/docs"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rail-btn"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
                  </svg>
                </a>
              </RailTooltip>
            )}
            {railExpanded ? (
              <button
                onClick={() => { setActiveView('settings'); setSidebarOpen(true) }}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-[13px] font-500 cursor-pointer transition-all
                  ${activeView === 'settings' ? 'bg-primary text-primary-foreground border-primary' : 'bg-transparent text-muted-foreground hover:text-foreground hover:bg-muted border-none'}`}
                style={{ fontFamily: 'inherit' }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
                Settings
              </button>
            ) : (
              <RailTooltip label="Settings" description="API keys, providers & app config">
                <button onClick={() => { setActiveView('settings'); setSidebarOpen(true) }} className={`rail-btn ${activeView === 'settings' ? 'active' : ''}`}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                </button>
              </RailTooltip>
            )}


            {railExpanded ? (
              <button
                onClick={handleSwitchUser}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-[10px] cursor-pointer transition-all
                  bg-transparent hover:bg-muted border-none"
                style={{ fontFamily: 'inherit' }}
              >
                <Avatar user={currentUser!} size="sm" />
                <span className="text-[13px] font-500 text-foreground capitalize truncate">{currentUser}</span>
              </button>
            ) : (
              <RailTooltip label="Switch User" description="Sign in as a different user">
                <button onClick={handleSwitchUser} className="mt-2 bg-transparent border-none cursor-pointer shrink-0">
                  <Avatar user={currentUser!} size="sm" />
                </button>
              </RailTooltip>
            )}
          </div>
        </div>
      )
      }

      {/* Desktop: Side panel */}
      {
        isDesktop && sidebarOpen && (
          <div
            className="w-[280px] shrink-0 bg-card border-r border-border flex flex-col h-full"
            style={{ animation: 'panel-in 0.2s cubic-bezier(0.16, 1, 0.3, 1)' }}
          >
            <div className="flex items-center px-6 pt-5 pb-3 shrink-0">
              <h2 className="font-display text-[14px] font-600 text-foreground tracking-[-0.01em] uppercase opacity-40 flex-1">
                {activeView === 'settings' ? 'App Settings' : activeView === 'logs' ? 'System Logs' : activeView}
              </h2>
            </div>
            {activeView === 'sessions' && (
              <>
                <UpdateBanner />
                <NetworkBanner />
                <SessionList inSidebar onSelect={() => { }} />
                {Object.keys(sessions).filter(id => sessions[id].name !== '__main__').length > 0 && (
                  <div className="px-3 pb-3 shrink-0">
                    <button
                      onClick={openNewSheet}
                      className="w-full py-2.5 rounded-[12px] bg-primary/10 text-primary border border-primary/20
                        text-[13px] font-600 cursor-pointer hover:bg-primary/20 transition-all flex items-center justify-center gap-2"
                      style={{ fontFamily: 'inherit' }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                        <line x1="12" y1="5" x2="12" y2="19" />
                        <line x1="5" y1="12" x2="19" y2="12" />
                      </svg>
                      New Session
                    </button>
                  </div>
                )}
              </>
            )}
            {activeView === 'agents' && <AgentList inSidebar />}
            {activeView === 'schedules' && <ScheduleList inSidebar />}
            {activeView === 'memory' && <MemoryList inSidebar />}
            {activeView === 'tasks' && <TaskList inSidebar />}
            {activeView === 'secrets' && <SecretsList inSidebar />}
            {activeView === 'providers' && <ProviderList inSidebar />}
            {activeView === 'skills' && <SkillList inSidebar />}
            {activeView === 'connectors' && <ConnectorList inSidebar />}
            {activeView === 'webhooks' && <WebhookList inSidebar />}
            {activeView === 'logs' && <LogList />}
            {activeView === 'settings' && <SettingsSidebar />}
          </div>
        )
      }

      {/* Mobile: Drawer */}
      {
        !isDesktop && sidebarOpen && (
          <div className="fixed inset-0 z-50">
            <div className="absolute inset-0 bg-black/60" onClick={() => setSidebarOpen(false)} />
            <div
              className="absolute inset-y-0 left-0 w-[300px] bg-card shadow-2xl flex flex-col"
              style={{ animation: 'slide-in-left 0.25s cubic-bezier(0.16, 1, 0.3, 1)' }}
            >
              <div className="flex flex-col px-6 pt-8 pb-4 shrink-0 gap-6">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-[12px] bg-primary flex items-center justify-center shrink-0
                  shadow-[0_6px_16px_rgba(var(--primary-rgb),0.25)]">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-white">
                      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3 1.07.56 2 1.56 2 3a2.5 2.5 0 0 1-2.5 2.5z" />
                      <path d="M12 2c0 2.22-1 3.5-2 5.5 2.5 1 5.5 5 5.5 9.5a5.5 5.5 0 1 1-11 0c0-1.55.64-2.31 1.54-3.5a14.95 14.95 0 0 1 1.05-3c-.15.14-.35.15-.45.15-1.5 0-2.39-1.39-2.39-2.65 0-2.12 1.56-4.49 1.86-4.99L12 2z" />
                    </svg>
                  </div>
                  <div className="flex flex-col flex-1">
                    <span className="font-display text-[11px] font-900 tracking-[0.2em] text-muted-foreground/40 uppercase leading-none mb-1">
                      Agent
                    </span>
                    <span className="font-display text-[22px] font-900 tracking-[-0.04em] text-foreground leading-none">
                      EMBER
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <a href="https://agent-ember.ai/docs" target="_blank" rel="noopener noreferrer" className="rail-btn" title="Documentation">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
                      </svg>
                    </a>
                    <button onClick={handleSwitchUser} className="bg-transparent border-none cursor-pointer shrink-0 ml-1">
                      <Avatar user={currentUser!} size="sm" />
                    </button>
                  </div>
                </div>

                {activeView !== 'logs' && activeView !== 'settings' && (
                  <button
                    onClick={() => {
                      setSidebarOpen(false)
                      openNewSheet()
                    }}
                    className="w-full h-11 rounded-[12px] bg-primary text-primary-foreground text-[14px] font-700 cursor-pointer
                    active:scale-[0.98] transition-all
                    shadow-md flex items-center justify-center gap-2"
                    style={{ fontFamily: 'inherit' }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    New {activeView === 'sessions' ? 'Chat' : activeView === 'agents' ? 'Agent' : activeView === 'schedules' ? 'Schedule' : activeView === 'tasks' ? 'Task' : activeView === 'secrets' ? 'Secret' : activeView === 'providers' ? 'Provider' : activeView === 'skills' ? 'Skill' : activeView === 'connectors' ? 'Connector' : activeView === 'webhooks' ? 'Webhook' : 'Entry'}
                  </button>
                )}
              </div>
              {/* View selector tabs */}
              <div className="flex px-4 py-2 gap-1 shrink-0 flex-wrap">
                {(['sessions', 'agents', 'schedules', 'memory', 'tasks', 'secrets', 'providers', 'skills', 'connectors', 'webhooks', 'logs', 'settings'] as AppView[]).map((v) => (
                  <button
                    key={v}
                    onClick={() => setActiveView(v)}
                    className={`py-2 px-2.5 rounded-[10px] text-[11px] font-600 capitalize cursor-pointer transition-all
                    ${activeView === v
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground hover:text-foreground'}`}
                    style={{ fontFamily: 'inherit' }}
                  >
                    {v}
                  </button>
                ))}
              </div>
              <div className="px-4 py-2.5 shrink-0">
                <button
                  onClick={() => {
                    setSidebarOpen(false)
                    openNewSheet()
                  }}
                  className="w-full py-3 rounded-[12px] border-none bg-primary text-primary-foreground text-[14px] font-600 cursor-pointer
                  hover:opacity-90 active:scale-[0.98] transition-all
                  shadow-sm"
                  style={{ fontFamily: 'inherit' }}
                >
                  + New {activeView === 'sessions' ? 'Session' : activeView === 'agents' ? 'Agent' : activeView === 'schedules' ? 'Schedule' : activeView === 'tasks' ? 'Task' : activeView === 'secrets' ? 'Secret' : activeView === 'providers' ? 'Provider' : activeView === 'skills' ? 'Skill' : activeView === 'connectors' ? 'Connector' : activeView === 'webhooks' ? 'Webhook' : 'Entry'}
                </button>
              </div>
              {activeView === 'settings' && (
                <div className="flex-1 overflow-y-auto">
                  <SettingsSidebar />
                </div>
              )}
              {activeView === 'sessions' && (
                <>
                  <UpdateBanner />
                  <NetworkBanner />
                  <SessionList inSidebar onSelect={() => setSidebarOpen(false)} />
                </>
              )}
              {activeView === 'agents' && <AgentList inSidebar />}
              {activeView === 'schedules' && <ScheduleList inSidebar />}
              {activeView === 'memory' && <MemoryList inSidebar />}
              {activeView === 'tasks' && <TaskList inSidebar />}
              {activeView === 'secrets' && <SecretsList inSidebar />}
              {activeView === 'providers' && <ProviderList inSidebar />}
              {activeView === 'skills' && <SkillList inSidebar />}
              {activeView === 'connectors' && <ConnectorList inSidebar />}
              {activeView === 'webhooks' && <WebhookList inSidebar />}
              {activeView === 'logs' && <LogList />}
            </div>
          </div>
        )
      }

      {/* Main content */}
      <div className="flex-1 flex flex-col h-full min-w-0 bg-background">
        {!isDesktop && <MobileHeader />}
        {newSessionOpen ? (
          <NewSessionView />
        ) : activeView === 'sessions' && currentSessionId ? (
          <ChatArea />
        ) : activeView === 'sessions' ? (
          isDesktop ? <WelcomeScreen /> : (
            <div className="flex-1 flex flex-col">
              <SessionList />
            </div>
          )
        ) : activeView === 'tasks' && isDesktop ? (
          <TaskBoard />
        ) : activeView === 'memory' ? (
          <MemoryDetail />
        ) : activeView === 'settings' ? (
          <SettingsView />
        ) : (
          <ViewEmptyState view={activeView} />
        )}
      </div>

      <AgentSheet />
      <ScheduleSheet />
      <MemorySheet />
      <TaskSheet />
      <SecretSheet />
      <ProviderSheet />
      <SkillSheet />
      <ConnectorSheet />
      <WebhookSheet />
    </div >
  )
}

const VIEW_DESCRIPTIONS: Record<AppView, string> = {
  sessions: 'Chat sessions with AI agents',
  agents: 'Configure AI agents & orchestrators',
  schedules: 'Automated task schedules',
  memory: 'Long-term agent memory store',
  tasks: 'Task board for orchestrator jobs',
  secrets: 'API keys & credentials for orchestrators',
  providers: 'LLM providers & custom endpoints',
  skills: 'Reusable instruction sets for agents',
  connectors: 'Chat platform bridges (Discord, Slack, etc.)',
  webhooks: 'Inbound HTTP triggers for event-driven workflows',
  logs: 'Application logs & error tracking',
  settings: 'Manage providers, API keys & app config',
}

const VIEW_EMPTY_STATES: Record<Exclude<AppView, 'sessions'>, { icon: string; title: string; description: string; features: string[] }> = {
  agents: {
    icon: 'user',
    title: 'Agents',
    description: 'Create and manage AI agents and orchestrators. Each agent has its own system prompt, provider, and model configuration.',
    features: ['Define custom system prompts for specialized agents', 'Configure which provider and model each agent uses', 'Create orchestrators that coordinate multiple agents', 'Generate agents with AI from a natural language description'],
  },
  schedules: {
    icon: 'clock',
    title: 'Schedules',
    description: 'Automate recurring tasks by scheduling orchestrators to run on a cron, interval, or one-time basis.',
    features: ['Set up cron expressions for precise timing', 'Run orchestrators automatically on intervals', 'Schedule one-time future tasks', 'View execution history and results'],
  },
  memory: {
    icon: 'database',
    title: 'Memory',
    description: 'Long-term memory store for AI agents. Orchestrators can store and retrieve knowledge across sessions.',
    features: ['Agents store findings and learnings automatically', 'Full-text search across all stored memories', 'Organized by categories and agents', 'Persists across sessions for continuity'],
  },
  tasks: {
    icon: 'clipboard',
    title: 'Task Board',
    description: 'A Trello-style board for managing orchestrator jobs. Create tasks, assign them to orchestrators, and track progress.',
    features: ['Kanban columns: Backlog, Queued, Running, Completed, Failed', 'Assign tasks to specific orchestrator agents', 'Sequential queue ensures orchestrators don\'t conflict', 'View results and session logs for completed tasks'],
  },
  secrets: {
    icon: 'lock',
    title: 'Secrets',
    description: 'Manage API keys and credentials that orchestrators can access during task execution.',
    features: ['Store keys for external services (Gmail, APIs, etc.)', 'Scope secrets globally or to specific orchestrators', 'Encrypted at rest with AES-256-GCM', 'Orchestrators retrieve secrets via the get_secret tool'],
  },
  providers: {
    icon: 'zap',
    title: 'Providers',
    description: 'Manage LLM providers including built-in and custom OpenAI-compatible endpoints.',
    features: ['Built-in support for Claude, OpenAI, Anthropic, and Ollama', 'Add custom OpenAI-compatible providers (OpenRouter, Together, Groq)', 'Configure base URLs, models, and API keys per provider', 'Custom providers work seamlessly with all features'],
  },
  skills: {
    icon: 'book',
    title: 'Skills',
    description: 'Upload and manage reusable instruction sets that agents can use during task execution.',
    features: ['Upload markdown files with specialized instructions', 'Assign skills to specific agents', 'Skills are injected into agent system prompts', 'Create libraries of reusable expertise'],
  },
  connectors: {
    icon: 'link',
    title: 'Connectors',
    description: 'Bridge chat platforms to your AI agents. Receive messages from Discord, Telegram, Slack, or WhatsApp and route them to agents.',
    features: ['Connect Discord, Telegram, Slack, or WhatsApp bots', 'Route incoming messages to any agent', 'Each platform channel gets its own session', 'Start and stop connectors from the UI'],
  },
  webhooks: {
    icon: 'webhook',
    title: 'Webhooks',
    description: 'Receive external events over HTTP and trigger orchestrator runs automatically.',
    features: ['Create secure inbound webhook endpoints', 'Filter events by type or source', 'Route each webhook to a specific orchestrator', 'Use x-webhook-secret for request authentication'],
  },
  logs: {
    icon: 'file-text',
    title: 'Logs',
    description: 'View application logs, errors, and debug information. Logs auto-refresh in real-time.',
    features: ['Filter by level: ERROR, WARN, INFO, DEBUG', 'Search through log entries', 'Auto-refresh with live mode', 'Click entries to expand details'],
  },
  settings: {
    icon: 'settings',
    title: 'Settings',
    description: 'Configure your orchestration engine, manage API providers, and set up your workspace preferences.',
    features: ['Switch between different orchestration LLMs', 'Manage API keys for various AI providers', 'Set safety guards for autonomous loops', 'Install and manage plugins and hooks'],
  },
}

function ViewEmptyState({ view }: { view: AppView }) {
  if (view === 'sessions') return null
  const config = VIEW_EMPTY_STATES[view]
  if (!config) return null

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-8 pb-20 relative overflow-hidden">
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-[30%] left-[50%] -translate-x-1/2 -translate-y-1/2 w-[600px] h-[350px]"
          style={{
            background: 'radial-gradient(ellipse at center, oklch(0.705 0.201 47.333 / 0.05) 0%, transparent 70%)',
            animation: 'glow-pulse 8s ease-in-out infinite',
          }} />
      </div>

      <div className="relative max-w-[520px] w-full text-center"
        style={{ animation: 'fade-in 0.5s cubic-bezier(0.16, 1, 0.3, 1)' }}>
        <div className="flex justify-center mb-6">
          <div className="w-14 h-14 rounded-[16px] bg-muted border border-border flex items-center justify-center">
            <ViewEmptyIcon type={config.icon} />
          </div>
        </div>

        <h2 className="font-display text-[28px] font-800 leading-[1.15] tracking-[-0.03em] mb-3 text-foreground">
          {config.title}
        </h2>
        <p className="text-[14px] text-muted-foreground leading-[1.6] mb-8 max-w-[400px] mx-auto">
          {config.description}
        </p>

        <div className="text-left max-w-[380px] mx-auto space-y-3">
          {config.features.map((feature) => (
            <div key={feature} className="flex items-start gap-3">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-primary shrink-0 mt-0.5">
                <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" opacity="0.3" />
              </svg>
              <span className="text-[13px] text-foreground/70 leading-[1.5]">{feature}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function ViewEmptyIcon({ type }: { type: string }) {
  const cls = "text-muted-foreground"
  switch (type) {
    case 'user':
      return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={cls}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
    case 'clock':
      return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={cls}><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
    case 'database':
      return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={cls}><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" /></svg>
    case 'clipboard':
      return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={cls}><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" /><rect x="9" y="3" width="6" height="4" rx="1" /><path d="M9 14l2 2 4-4" /></svg>
    case 'lock':
      return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={cls}><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
    case 'zap':
      return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={cls}><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" /></svg>
    case 'book':
      return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={cls}><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" /></svg>
    case 'link':
      return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={cls}><path d="M15 7h3a5 5 0 0 1 5 5 5 5 0 0 1-5 5h-3m-6 0H6a5 5 0 0 1-5-5 5 5 0 0 1 5-5h3" /><line x1="8" y1="12" x2="16" y2="12" /></svg>
    case 'webhook':
      return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={cls}><path d="M22 12h-4l-3 7L9 5l-3 7H2" /></svg>
    default:
      return null
  }
}

function NavItem({ view, label, expanded, active, sidebarOpen, onClick, children }: {
  view: AppView
  label: string
  expanded: boolean
  active: AppView
  sidebarOpen: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  const isActive = active === view && sidebarOpen

  if (expanded) {
    return (
      <button
        onClick={onClick}
        className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-[13px] font-500 cursor-pointer transition-all border-none
          ${isActive
            ? 'bg-primary text-primary-foreground shadow-sm'
            : 'bg-transparent text-muted-foreground hover:text-foreground hover:bg-muted'}`}
        style={{ fontFamily: 'inherit' }}
      >
        <span className="shrink-0">{children}</span>
        <span className="truncate">{label}</span>
      </button>
    )
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button onClick={onClick} className={`rail-btn ${isActive ? 'active' : ''}`}>
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}
        className="bg-card border border-border text-foreground shadow-2xl rounded-[10px] px-3.5 py-2.5 max-w-[200px]">
        <div className="font-display text-[13px] font-600 mb-0.5">{label}</div>
        <div className="text-[11px] text-muted-foreground leading-[1.4]">{VIEW_DESCRIPTIONS[view]}</div>
      </TooltipContent>
    </Tooltip>
  )
}

function RailTooltip({ label, description, children }: { label: string; description: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}
        className="bg-card border border-border text-foreground shadow-2xl rounded-[10px] px-3.5 py-2.5 max-w-[200px]">
        <div className="font-display text-[13px] font-600 mb-0.5">{label}</div>
        <div className="text-[11px] text-muted-foreground leading-[1.4]">{description}</div>
      </TooltipContent>
    </Tooltip>
  )
}

function DesktopEmptyState({ userName }: { userName: string | null }) {
  const setNewSessionOpen = useAppStore((s) => s.setNewSessionOpen)

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-8 pb-20 relative overflow-hidden">
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-[30%] left-[50%] -translate-x-1/2 -translate-y-1/2 w-[700px] h-[400px]"
          style={{
            background: 'radial-gradient(ellipse at center, oklch(0.705 0.201 47.333 / 0.05) 0%, transparent 70%)',
            animation: 'glow-pulse 8s ease-in-out infinite',
          }} />
      </div>

      <div className="relative max-w-[560px] w-full text-center"
        style={{ animation: 'fade-in 0.6s cubic-bezier(0.16, 1, 0.3, 1)' }}>
        <div className="flex justify-center mb-8">
          <div className="relative">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-primary mb-5"
              style={{ animation: 'sparkle-spin 8s linear infinite' }}>
              <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3 1.07.56 2 1.56 2 3a2.5 2.5 0 0 1-2.5 2.5z" />
              <path d="M12 2c0 2.22-1 3.5-2 5.5 2.5 1 5.5 5 5.5 9.5a5.5 5.5 0 1 1-11 0c0-1.55.64-2.31 1.54-3.5a14.95 14.95 0 0 1 1.05-3c-.15.14-.35.15-.45.15-1.5 0-2.39-1.39-2.39-2.65 0-2.12 1.56-4.49 1.86-4.99L12 2z" />
            </svg>
          </div>
        </div>

        <h1 className="font-display text-[44px] font-800 leading-[1.1] tracking-[-0.04em] mb-5">
          Hi, <span className="text-primary">{userName ? userName.charAt(0).toUpperCase() + userName.slice(1) : 'there'}</span>
          <br />
          <span className="text-foreground">What would you like to do?</span>
        </h1>
        <p className="text-[15px] text-muted-foreground mb-12">
          Create a new session to start chatting
        </p>
        <button
          onClick={() => setNewSessionOpen(true)}
          className="inline-flex items-center gap-2.5 px-12 py-4 rounded-[16px] border-none bg-primary text-primary-foreground text-[16px] font-display font-600
            cursor-pointer hover:opacity-90 active:scale-[0.97] transition-all duration-200
            shadow-sm"
          style={{ fontFamily: 'inherit' }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New Session
        </button>
      </div>
    </div>
  )
}
