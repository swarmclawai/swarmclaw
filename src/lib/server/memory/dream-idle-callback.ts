import { onNextIdleWindow } from '@/lib/server/runtime/idle-window'
import { loadAgents } from '@/lib/server/storage'
import { executeDreamCycle, resolveDreamConfig } from './dream-service'
import { log } from '@/lib/server/logger'
import { errorMessage } from '@/lib/shared-utils'

const TAG = 'dream-idle'
let dreamRegistered = false

export function registerDreamIdleCallback(): void {
  if (dreamRegistered) return
  dreamRegistered = true
  onNextIdleWindow(async () => {
    dreamRegistered = false
    await runDreamForEligibleAgents()
    registerDreamIdleCallback()
  })
}

async function runDreamForEligibleAgents(): Promise<void> {
  const agents = loadAgents()
  const now = Date.now()

  for (const agent of Object.values(agents)) {
    if (agent.trashedAt) continue
    if (!agent.dreamEnabled) continue

    const config = resolveDreamConfig(agent)
    const lastDream = agent.lastDreamAt ?? 0
    if (lastDream + config.cooldownMinutes * 60_000 >= now) continue

    try {
      await executeDreamCycle(agent.id, 'idle')
    } catch (err: unknown) {
      log.error(TAG, `Dream cycle failed for agent ${agent.id}: ${errorMessage(err)}`)
    }
  }
}
