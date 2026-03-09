'use client'

import { create } from 'zustand'
import type { AuthSlice, SessionSlice, UiSlice, AgentSlice, TaskSlice, DataSlice } from './slices'
import { createAuthSlice } from './slices/auth-slice'
import { createSessionSlice } from './slices/session-slice'
import { createUiSlice } from './slices/ui-slice'
import { createAgentSlice } from './slices/agent-slice'
import { createTaskSlice } from './slices/task-slice'
import { createDataSlice } from './slices/data-slice'

export type AppState = AuthSlice & SessionSlice & UiSlice & AgentSlice & TaskSlice & DataSlice

export const useAppStore = create<AppState>()((...a) => ({
  ...createAuthSlice(...a),
  ...createSessionSlice(...a),
  ...createUiSlice(...a),
  ...createAgentSlice(...a),
  ...createTaskSlice(...a),
  ...createDataSlice(...a)
}))
