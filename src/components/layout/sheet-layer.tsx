'use client'

import dynamic from 'next/dynamic'

// Lazy load all heavy overlay sheets to keep the initial AppLayout bundle tiny
const AgentSheet = dynamic(() => import('@/components/agents/agent-sheet').then(m => m.AgentSheet), { ssr: false })
const ScheduleSheet = dynamic(() => import('@/components/schedules/schedule-sheet').then(m => m.ScheduleSheet), { ssr: false })
const MemorySheet = dynamic(() => import('@/components/memory/memory-sheet').then(m => m.MemorySheet), { ssr: false })
const TaskSheet = dynamic(() => import('@/components/tasks/task-sheet').then(m => m.TaskSheet), { ssr: false })
const SecretSheet = dynamic(() => import('@/components/secrets/secret-sheet').then(m => m.SecretSheet), { ssr: false })
const ProviderSheet = dynamic(() => import('@/components/providers/provider-sheet').then(m => m.ProviderSheet), { ssr: false })
const GatewaySheet = dynamic(() => import('@/components/gateways/gateway-sheet').then(m => m.GatewaySheet), { ssr: false })
const SkillSheet = dynamic(() => import('@/components/skills/skill-sheet').then(m => m.SkillSheet), { ssr: false })
const ConnectorSheet = dynamic(() => import('@/components/connectors/connector-sheet').then(m => m.ConnectorSheet), { ssr: false })
const ChatroomSheet = dynamic(() => import('@/components/chatrooms/chatroom-sheet').then(m => m.ChatroomSheet), { ssr: false })
const WebhookSheet = dynamic(() => import('@/components/webhooks/webhook-sheet').then(m => m.WebhookSheet), { ssr: false })
const McpServerSheet = dynamic(() => import('@/components/mcp-servers/mcp-server-sheet').then(m => m.McpServerSheet), { ssr: false })
const KnowledgeSheet = dynamic(() => import('@/components/knowledge/knowledge-sheet').then(m => m.KnowledgeSheet), { ssr: false })
const PluginSheet = dynamic(() => import('@/components/plugins/plugin-sheet').then(m => m.PluginSheet), { ssr: false })
const ProjectSheet = dynamic(() => import('@/components/projects/project-sheet').then(m => m.ProjectSheet), { ssr: false })
const SearchDialog = dynamic(() => import('@/components/shared/search-dialog').then(m => m.SearchDialog), { ssr: false })
const AgentSwitchDialog = dynamic(() => import('@/components/shared/agent-switch-dialog').then(m => m.AgentSwitchDialog), { ssr: false })
const KeyboardShortcutsDialog = dynamic(() => import('@/components/shared/keyboard-shortcuts-dialog').then(m => m.KeyboardShortcutsDialog), { ssr: false })
const ProfileSheet = dynamic(() => import('@/components/shared/profile-sheet').then(m => m.ProfileSheet), { ssr: false })

export function SheetLayer({ profileSheetOpen, setProfileSheetOpen }: { profileSheetOpen: boolean, setProfileSheetOpen: (open: boolean) => void }) {
  return (
    <>
      <AgentSheet />
      <ScheduleSheet />
      <MemorySheet />
      <TaskSheet />
      <SecretSheet />
      <ProviderSheet />
      <GatewaySheet />
      <SkillSheet />
      <ConnectorSheet />
      <ChatroomSheet />
      <WebhookSheet />
      <McpServerSheet />
      <KnowledgeSheet />
      <PluginSheet />
      <ProjectSheet />
      <SearchDialog />
      <AgentSwitchDialog />
      <KeyboardShortcutsDialog />
      <ProfileSheet open={profileSheetOpen} onClose={() => setProfileSheetOpen(false)} />
    </>
  )
}
