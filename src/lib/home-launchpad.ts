export const HOME_LAUNCHPAD_AFTER_SETUP_KEY = 'sc_launchpad_after_setup_v1'
export const DEFAULT_BUILDER_ROUTE = '/protocols/builder/facilitated_discussion'

export type HomeMode = 'launchpad' | 'ops'

export interface HomeModeInput {
  hasLaunchpadFlag: boolean
  agentCount: number
  sessionCount: number
  taskCount: number
  scheduleCount: number
  connectorCount: number
  todayCost: number
}

export function isSparseWorkspace(input: Omit<HomeModeInput, 'hasLaunchpadFlag'>): boolean {
  return (
    input.agentCount <= 2
    && input.sessionCount === 0
    && input.taskCount === 0
    && input.scheduleCount === 0
    && input.connectorCount === 0
    && input.todayCost === 0
  )
}

export function deriveHomeMode(input: HomeModeInput): HomeMode {
  if (input.hasLaunchpadFlag) return 'launchpad'
  return isSparseWorkspace(input) ? 'launchpad' : 'ops'
}
