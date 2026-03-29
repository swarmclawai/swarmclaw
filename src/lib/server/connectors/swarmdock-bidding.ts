import { log } from '@/lib/server/logger'
import type { BidCreateInput } from '@swarmdock/shared'

const TAG = 'swarmdock-bid'

interface SwarmDockTask {
  id: string
  title: string
  skillRequirements: string[]
  budgetMax: string
}

interface SwarmDockConfig {
  skills: string
  maxBudget: string
  autoDiscover: boolean
}

/**
 * Determine if the agent should auto-bid on a discovered task.
 * Checks skill overlap and budget limits.
 */
export function shouldAutoBid(task: SwarmDockTask, config: SwarmDockConfig): boolean {
  if (!config.autoDiscover) return false

  // Check budget
  const maxBudget = BigInt(config.maxBudget || '0')
  if (maxBudget > BigInt(0)) {
    const taskBudget = BigInt(task.budgetMax || '0')
    if (taskBudget > maxBudget) {
      log.debug(TAG, `Skipping "${task.title}" — budget ${task.budgetMax} exceeds max ${config.maxBudget}`)
      return false
    }
  }

  // Check skill overlap
  const agentSkills = new Set(
    config.skills.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  )
  if (agentSkills.size === 0) return false

  const hasMatchingSkill = task.skillRequirements.some(
    (req) => agentSkills.has(req.toLowerCase()),
  )
  if (!hasMatchingSkill) {
    log.debug(TAG, `Skipping "${task.title}" — no matching skills`)
    return false
  }

  return true
}

/**
 * Submit an auto-bid on a SwarmDock task.
 * Uses the task's max budget as the proposed price (simple strategy).
 */
export async function submitAutoBid(
  client: { tasks: { bid: (taskId: string, input: BidCreateInput) => Promise<unknown> } },
  taskId: string,
  config: SwarmDockConfig,
): Promise<void> {
  const agentSkills = config.skills.split(',').map((s) => s.trim()).filter(Boolean)

  const bid: BidCreateInput = {
    proposedPrice: config.maxBudget || '1000000',
    confidenceScore: 0.8,
    proposal: `SwarmClaw agent with skills: ${agentSkills.join(', ')}. Ready to start immediately.`,
    portfolioRefs: [],
  }

  await client.tasks.bid(taskId, bid)

  log.info(TAG, `Auto-bid submitted for task ${taskId}`)
}
