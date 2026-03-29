import { log } from '@/lib/server/logger'
import { hmrSingleton } from '@/lib/shared-utils'
import { logActivity } from '@/lib/server/activity/activity-log'
import type { Connector, InboundMessage } from '@/types/connector'
import type { PlatformConnector, ConnectorInstance } from '@/lib/server/connectors/types'
import { createBoardTaskFromAssignment, updateBoardTaskFromEvent, findBoardTaskBySwarmdockId } from './swarmdock-tasks'
import { shouldAutoBid, submitAutoBid } from './swarmdock-bidding'
import type { TaskSubmitInput } from '@swarmdock/shared'

const TAG = 'swarmdock'

// SDK types inlined until @swarmdock/sdk is built and linked
interface SwarmDockTask {
  id: string
  requesterId: string
  assigneeId: string | null
  title: string
  description: string
  skillRequirements: string[]
  budgetMax: string
  status: string
  deadline: string | null
}

interface SwarmDockSSEEvent {
  type: string
  data: Record<string, unknown>
  timestamp: string
}

interface SwarmDockConfig {
  apiUrl: string
  walletAddress: string
  agentDescription: string
  skills: string
  autoDiscover: boolean
  maxBudget: string
}

function parseConfig(connector: Connector): SwarmDockConfig {
  const c = connector.config || {}
  return {
    apiUrl: c.apiUrl || 'https://api.swarmdock.ai',
    walletAddress: c.walletAddress || '',
    agentDescription: c.agentDescription || connector.name || '',
    skills: c.skills || '',
    autoDiscover: c.autoDiscover === 'true',
    maxBudget: c.maxBudget || '0',
  }
}

function buildTaskPrompt(task: SwarmDockTask): string {
  const lines: string[] = [
    `# SwarmDock Task: ${task.title}`,
    '',
    task.description,
    '',
    `**Required Skills:** ${task.skillRequirements.join(', ')}`,
    `**Budget:** ${formatUsdc(task.budgetMax)}`,
  ]
  if (task.deadline) lines.push(`**Deadline:** ${task.deadline}`)
  lines.push('', 'Complete this task and provide your deliverables. Your response will be submitted as the task result on the SwarmDock marketplace.')
  return lines.join('\n')
}

function formatUsdc(microUnits: string): string {
  const cents = BigInt(microUnits)
  const dollars = Number(cents) / 1_000_000
  return `$${dollars.toFixed(2)} USDC`
}

export async function submitSwarmdockTaskResult(
  client: { tasks: { submit: (taskId: string, input: TaskSubmitInput) => Promise<unknown> } },
  swarmdockTaskId: string,
  text: string,
): Promise<void> {
  const payload: TaskSubmitInput = {
    artifacts: [{ type: 'text/markdown', content: text }],
    files: [],
  }
  await client.tasks.submit(swarmdockTaskId, payload)
}

/** Runtime state: maps SwarmDock task IDs → SwarmClaw BoardTask IDs */
const taskIdMap = hmrSingleton('__swarmclaw_swarmdock_task_map__', () => new Map<string, string>())

const swarmdock: PlatformConnector = {
  async start(connector, _botToken, onMessage): Promise<ConnectorInstance> {
    const config = parseConfig(connector)
    const connectorId = connector.id
    const agentId = connector.agentId || ''
    const privateKey = _botToken || ''

    if (!privateKey) throw new Error('SwarmDock connector requires an Ed25519 private key credential')
    if (!config.walletAddress) throw new Error('SwarmDock connector requires a Base L2 wallet address in config')

    // Dynamic import of the SDK (must be built and linked first)
    let SwarmDockClient: typeof import('@swarmdock/sdk').SwarmDockClient
    try {
      const sdk = await import('@swarmdock/sdk')
      SwarmDockClient = sdk.SwarmDockClient
    } catch {
      throw new Error('SwarmDock SDK (@swarmdock/sdk) is not installed. Run: npm install @swarmdock/sdk')
    }

    const client = new SwarmDockClient({
      baseUrl: config.apiUrl,
      privateKey,
    })

    // Register agent on SwarmDock (Ed25519 challenge-response)
    const skillList = config.skills
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((skillId) => ({
        skillId,
        skillName: skillId.replace(/-/g, ' '),
        description: `${skillId} capability`,
        category: skillId,
        basePrice: '1000000', // $1.00 default
      }))

    log.info(TAG, `Registering agent "${connector.name}" on SwarmDock at ${config.apiUrl}`)
    const registration = await client.register({
      displayName: connector.name,
      description: config.agentDescription,
      framework: 'swarmclaw',
      walletAddress: config.walletAddress,
      skills: skillList,
    })
    log.info(TAG, `Registered as ${registration.agent.did} (trust level ${registration.agent.trustLevel})`)

    logActivity({
      entityType: 'connector',
      entityId: connectorId,
      action: 'swarmdock-registered',
      actor: 'system',
      summary: `Agent "${connector.name}" registered on SwarmDock as ${registration.agent.did}`,
    })

    // Set up SSE event stream
    let alive = true

    const handleSSEEvent = async (event: SwarmDockSSEEvent) => {
      if (!alive) return
      try {
        switch (event.type) {
          case 'task.created': {
            if (!config.autoDiscover) break
            const task = event.data as unknown as SwarmDockTask
            if (shouldAutoBid(task, config)) {
              await submitAutoBid(client, task.id, config)
              logActivity({
                entityType: 'connector',
                entityId: connectorId,
                action: 'swarmdock-bid',
                actor: 'system',
                summary: `Auto-bid on SwarmDock task: "${task.title}"`,
              })
            }
            break
          }

          case 'task.assigned': {
            const task = event.data as unknown as SwarmDockTask
            if (!task.assigneeId) break

            // Signal work started on SwarmDock
            try { await client.tasks.start(task.id) } catch {}

            // Create a BoardTask in SwarmClaw
            const boardTaskId = await createBoardTaskFromAssignment(task, agentId, connectorId, config.apiUrl)
            taskIdMap.set(task.id, boardTaskId)

            // Dispatch as inbound message to the assigned agent
            const inbound: InboundMessage = {
              platform: 'swarmdock',
              channelId: `swarmdock-task:${task.id}`,
              channelName: `SwarmDock: ${task.title}`,
              senderId: task.requesterId,
              senderName: `SwarmDock Requester`,
              text: buildTaskPrompt(task),
              messageId: task.id,
            }
            await onMessage(inbound)
            break
          }

          case 'task.completed':
          case 'task.cancelled':
          case 'task.failed': {
            const taskId = (event.data as Record<string, string>).taskId
            if (taskId) await updateBoardTaskFromEvent(taskId, event.type)
            break
          }

          case 'payment.released': {
            const data = event.data as Record<string, string>
            logActivity({
              entityType: 'connector',
              entityId: connectorId,
              action: 'swarmdock-payment',
              actor: 'system',
              summary: `Payment received: ${formatUsdc(data.amount || '0')} for task ${data.taskId}`,
            })
            break
          }
        }
      } catch (err) {
        log.error(TAG, `Error handling SSE event ${event.type}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    client.events.subscribe(handleSSEEvent as (event: unknown) => void)

    // Token refresh heartbeat (23h, token lasts 24h)
    const heartbeatInterval = setInterval(async () => {
      try {
        await client.heartbeat()
        log.debug(TAG, 'SwarmDock token refreshed')
      } catch (err) {
        log.error(TAG, `SwarmDock heartbeat failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }, 23 * 60 * 60 * 1000)

    return {
      connector,

      stop: async () => {
        alive = false
        clearInterval(heartbeatInterval)
        client.events.unsubscribe()
        log.info(TAG, 'SwarmDock connector stopped')
      },

      sendMessage: async (channelId: string, text: string) => {
        // channelId format: "swarmdock-task:{taskId}"
        const swarmdockTaskId = channelId.replace('swarmdock-task:', '')
        if (!swarmdockTaskId) return

        await submitSwarmdockTaskResult(client, swarmdockTaskId, text)
        log.info(TAG, `Submitted results for SwarmDock task ${swarmdockTaskId}`)

        if (findBoardTaskBySwarmdockId(swarmdockTaskId)) {
          await updateBoardTaskFromEvent(swarmdockTaskId, 'task.submitted')
        }

        return { messageId: swarmdockTaskId }
      },
    }
  },
}

export default swarmdock
