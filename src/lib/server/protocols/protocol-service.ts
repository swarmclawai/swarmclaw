/**
 * Protocol service — barrel re-export.
 *
 * This file was decomposed into focused modules inside this directory.
 * All public exports are re-exported here so existing import sites continue to work.
 */

// Types, interfaces, primitives
export type {
  ProtocolRunDetail,
  CreateProtocolRunInput,
  UpsertProtocolTemplateInput,
  ProtocolAgentTurnResult,
  ProtocolRunDeps,
  ProtocolRunActionInput,
} from '@/lib/server/protocols/protocol-types'

// Template CRUD
export {
  loadProtocolTemplateById,
  createProtocolTemplate,
  updateProtocolTemplate,
  deleteProtocolTemplateById,
} from '@/lib/server/protocols/protocol-templates'

// Queries
export {
  listProtocolTemplates,
  listProtocolRuns,
  loadProtocolRunById,
  listProtocolRunEventsForRun,
  deleteProtocolRunById,
  getProtocolRunDetail,
  hasActiveProtocolRunForSchedule,
} from '@/lib/server/protocols/protocol-queries'

// Run lifecycle: create, run, action, scheduling, recovery, launch helpers
export {
  requestProtocolRunExecution,
  wakeProtocolRunFromTaskCompletion,
  ensureProtocolEngineRecovered,
  createProtocolRun,
  runProtocolRun,
  performProtocolRunAction,
  launchProtocolRunForSchedule,
  launchProtocolRunForTask,
} from '@/lib/server/protocols/protocol-run-lifecycle'

// Swarm exports
export {
  claimSwarmWorkItem,
  syncSwarmClaimCompletion,
  checkSwarmTimeouts,
} from '@/lib/server/protocols/protocol-swarm'
