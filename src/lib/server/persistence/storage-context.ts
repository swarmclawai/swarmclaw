import { withTransaction } from '@/lib/server/storage'

import { agentRepository } from '@/lib/server/agents/agent-repository'
import { approvalRepository } from '@/lib/server/approvals/approval-repository'
import { chatroomRepository } from '@/lib/server/chatrooms/chatroom-repository'
import { connectorRepository } from '@/lib/server/connectors/connector-repository'
import * as messageRepository from '@/lib/server/messages/message-repository'
import { missionEventRepository, missionRepository } from '@/lib/server/missions/mission-repository'
import { projectRepository } from '@/lib/server/projects/project-repository'
import { scheduleRepository } from '@/lib/server/schedules/schedule-repository'
import { sessionRepository } from '@/lib/server/sessions/session-repository'
import { settingsRepository } from '@/lib/server/settings/settings-repository'
import { taskRepository } from '@/lib/server/tasks/task-repository'
import { runEventRepository, runRepository } from '@/lib/server/runtime/run-repository'

export interface StorageTxContext {
  agents: typeof agentRepository
  approvals: typeof approvalRepository
  chatrooms: typeof chatroomRepository
  connectors: typeof connectorRepository
  messages: typeof messageRepository
  missions: typeof missionRepository
  missionEvents: typeof missionEventRepository
  projects: typeof projectRepository
  runs: typeof runRepository
  runEvents: typeof runEventRepository
  schedules: typeof scheduleRepository
  sessions: typeof sessionRepository
  settings: typeof settingsRepository
  tasks: typeof taskRepository
}

export function createStorageTxContext(): StorageTxContext {
  return {
    agents: agentRepository,
    approvals: approvalRepository,
    chatrooms: chatroomRepository,
    connectors: connectorRepository,
    messages: messageRepository,
    missions: missionRepository,
    missionEvents: missionEventRepository,
    projects: projectRepository,
    runs: runRepository,
    runEvents: runEventRepository,
    schedules: scheduleRepository,
    sessions: sessionRepository,
    settings: settingsRepository,
    tasks: taskRepository,
  }
}

export function withStorageTx<T>(fn: (ctx: StorageTxContext) => T): T {
  return withTransaction(() => fn(createStorageTxContext()))
}
