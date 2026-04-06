import { log } from '@/lib/server/logger'
import { hmrSingleton } from '@/lib/shared-utils'
import { logActivity } from '@/lib/server/activity/activity-log'
import type { Connector, InboundMessage } from '@/types/connector'
import type { Agent } from '@/types/agent'
import type { AgentWallet } from '@/types/swarmdock'
import type { PlatformConnector, ConnectorInstance } from '@/lib/server/connectors/types'
import { createBoardTaskFromAssignment, updateBoardTaskFromEvent, findBoardTaskBySwarmdockId } from './swarmdock-tasks'
import { shouldAutoBid, submitAutoBid } from './swarmdock-bidding'
import type {
  Agent as SwarmDockAgentProfile,
  AgentSkill,
  AgentUpdateInput,
  SSEEvent,
  Task,
  TaskSubmitInput,
} from '@swarmdock/shared'

const TAG = 'swarmdock'
const DEFAULT_SWARMDOCK_API_URL = 'https://swarmdock-api.onrender.com'

export interface SwarmDockSkillPayload {
  skillId: string
  skillName: string
  description: string
  category: string
  tags: string[]
  inputModes: string[]
  outputModes: string[]
  pricingModel: string
  basePrice: string
  examplePrompts: string[]
}

export interface DesiredSwarmDockProfile {
  displayName: string
  description: string
  framework: string
  modelProvider?: string
  modelName?: string
  walletAddress: string
  skills: SwarmDockSkillPayload[]
}

type SwarmDockProfileSnapshot = Pick<
  SwarmDockAgentProfile,
  'id' | 'did' | 'createdAt' | 'displayName' | 'description' | 'framework' | 'modelProvider' | 'modelName' | 'walletAddress'
> & {
  skills?: Array<Pick<
    AgentSkill,
    'skillId' | 'skillName' | 'description' | 'category' | 'tags' | 'inputModes' | 'outputModes' | 'pricingModel' | 'basePrice' | 'examplePrompts'
  >>
}

interface SwarmDockConfig {
  apiUrl: string
  walletAddress: string
  agentDescription: string
  skills: string
  autoDiscover: boolean
  maxBudget: string
  paymentPrivateKey?: string
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function resolveSwarmDockWalletAddress(agent?: Agent, wallet?: AgentWallet | null): string {
  if (!agent?.swarmdockWalletId || !wallet) return ''
  if (wallet.id !== agent.swarmdockWalletId) return ''
  if (wallet.agentId !== agent.id) return ''
  return clean(wallet.walletAddress)
}

export function resolveSwarmDockConfig(
  connector: Connector,
  agent?: Agent,
  fallbackWalletAddress?: string | null,
): SwarmDockConfig {
  const c = connector.config || {}
  return {
    apiUrl: clean(c.apiUrl) || DEFAULT_SWARMDOCK_API_URL,
    walletAddress: clean(c.walletAddress) || clean(fallbackWalletAddress),
    agentDescription: clean(c.agentDescription) || clean(agent?.swarmdockDescription) || clean(connector.name),
    skills: clean(c.skills) || (Array.isArray(agent?.swarmdockSkills) ? agent.swarmdockSkills.join(',') : ''),
    autoDiscover: c.autoDiscover === 'true' || (agent?.swarmdockMarketplace?.autoDiscover ?? false),
    maxBudget: clean(c.maxBudget) || clean(agent?.swarmdockMarketplace?.maxBudgetUsdc) || '0',
    paymentPrivateKey: clean(c.paymentPrivateKey) || undefined,
  }
}

export function buildSwarmDockSkillPayload(skills: string): SwarmDockSkillPayload[] {
  return skills
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((skillId) => ({
      skillId,
      skillName: skillId.replace(/-/g, ' '),
      description: `${skillId} capability`,
      category: skillId,
      tags: [],
      basePrice: '1000000',
      inputModes: ['text'],
      outputModes: ['text'],
      pricingModel: 'per-task',
      examplePrompts: generateExamplePrompts(skillId),
    }))
}

export function buildDesiredSwarmDockProfile(
  connector: Connector,
  config: SwarmDockConfig,
  agent?: Agent,
): DesiredSwarmDockProfile {
  return {
    displayName: connector.name,
    description: config.agentDescription,
    framework: 'swarmclaw',
    modelProvider: agent?.provider,
    modelName: agent?.model,
    walletAddress: config.walletAddress,
    skills: buildSwarmDockSkillPayload(config.skills),
  }
}

function normalizeComparableSkills(skills: Array<Pick<
  AgentSkill | SwarmDockSkillPayload,
  'skillId' | 'skillName' | 'description' | 'category' | 'tags' | 'inputModes' | 'outputModes' | 'pricingModel' | 'basePrice' | 'examplePrompts'
>>): SwarmDockSkillPayload[] {
  return skills
    .map((skill) => ({
      skillId: skill.skillId,
      skillName: skill.skillName,
      description: skill.description,
      category: skill.category,
      tags: [...(skill.tags ?? [])],
      inputModes: [...(skill.inputModes ?? [])],
      outputModes: [...(skill.outputModes ?? [])],
      pricingModel: skill.pricingModel,
      basePrice: String(skill.basePrice),
      examplePrompts: [...(skill.examplePrompts ?? [])],
    }))
    .sort((a, b) => a.skillId.localeCompare(b.skillId))
}

export function diffSwarmDockProfile(
  liveProfile: SwarmDockProfileSnapshot,
  desired: DesiredSwarmDockProfile,
): { profileFields: AgentUpdateInput; shouldUpdateSkills: boolean } {
  const profileFields: AgentUpdateInput = {}

  if (liveProfile.displayName !== desired.displayName) profileFields.displayName = desired.displayName
  if ((liveProfile.description ?? '') !== desired.description) profileFields.description = desired.description
  if ((liveProfile.framework ?? '') !== desired.framework) profileFields.framework = desired.framework
  if ((liveProfile.modelProvider ?? '') !== (desired.modelProvider ?? '')) profileFields.modelProvider = desired.modelProvider ?? ''
  if ((liveProfile.modelName ?? '') !== (desired.modelName ?? '')) profileFields.modelName = desired.modelName ?? ''
  if (liveProfile.walletAddress !== desired.walletAddress) profileFields.walletAddress = desired.walletAddress

  const liveSkills = normalizeComparableSkills(liveProfile.skills ?? [])
  const desiredSkills = normalizeComparableSkills(desired.skills)
  const shouldUpdateSkills = JSON.stringify(liveSkills) !== JSON.stringify(desiredSkills)

  return { profileFields, shouldUpdateSkills }
}

export async function syncSwarmDockProfile(
  client: {
    profile: {
      get: () => Promise<SwarmDockProfileSnapshot>
      update: (fields: AgentUpdateInput) => Promise<unknown>
      updateSkills: (skills: SwarmDockSkillPayload[]) => Promise<unknown>
    }
  },
  desired: DesiredSwarmDockProfile,
): Promise<{ liveProfile: SwarmDockProfileSnapshot; updatedProfile: boolean; updatedSkills: boolean }> {
  const liveProfile = await client.profile.get()
  const { profileFields, shouldUpdateSkills } = diffSwarmDockProfile(liveProfile, desired)
  const updatedProfile = Object.keys(profileFields).length > 0

  if (updatedProfile) {
    await client.profile.update(profileFields)
  }
  if (shouldUpdateSkills) {
    await client.profile.updateSkills(desired.skills)
  }

  return { liveProfile, updatedProfile, updatedSkills: shouldUpdateSkills }
}

export function buildSwarmDockAgentBackfill(
  profile: Pick<SwarmDockAgentProfile, 'id' | 'did'> & { createdAt?: string | null },
): Pick<Agent, 'swarmdockAgentId' | 'swarmdockDid' | 'swarmdockListedAt'> {
  return {
    swarmdockAgentId: profile.id,
    swarmdockDid: profile.did,
    swarmdockListedAt: parseTimestamp(profile.createdAt) ?? Date.now(),
  }
}

async function persistSwarmDockAgentBackfill(
  agent: Agent | undefined,
  profile: Pick<SwarmDockAgentProfile, 'id' | 'did'> & { createdAt?: string | null },
) {
  if (!agent) return
  const backfill = buildSwarmDockAgentBackfill(profile)
  const { patchAgent } = await import('@/lib/server/agents/agent-repository')
  patchAgent(agent.id, (current) => {
    if (!current) return null

    const needsId = !current.swarmdockAgentId
    const needsDid = !current.swarmdockDid
    const needsListedAt = current.swarmdockListedAt == null
    if (!needsId && !needsDid && !needsListedAt) return current

    return {
      ...current,
      ...(needsId ? { swarmdockAgentId: backfill.swarmdockAgentId } : {}),
      ...(needsDid ? { swarmdockDid: backfill.swarmdockDid } : {}),
      ...(needsListedAt ? { swarmdockListedAt: backfill.swarmdockListedAt } : {}),
      updatedAt: Date.now(),
    }
  })
}

function buildTaskPrompt(task: Task): string {
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

export function generateExamplePrompts(skillId: string): string[] {
  const name = skillId.replace(/-/g, ' ')
  return [
    `Perform a ${name} task`,
    `Help me with ${name}`,
    `I need ${name} work done`,
    `Complete a ${name} assignment`,
    `Handle a ${name} request`,
  ]
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
  notes?: string,
): Promise<void> {
  const payload: TaskSubmitInput = {
    artifacts: [{ type: 'text/markdown', content: text }],
    files: [],
  }
  if (notes) payload.notes = notes
  await client.tasks.submit(swarmdockTaskId, payload)
}

/** Runtime state: maps SwarmDock task IDs → SwarmClaw BoardTask IDs */
const taskIdMap = hmrSingleton('__swarmclaw_swarmdock_task_map__', () => new Map<string, string>())

const swarmdock: PlatformConnector = {
  async start(connector, _botToken, onMessage): Promise<ConnectorInstance> {
    // Load agent to use agent-level fields as fallbacks for connector config
    let agent: Agent | undefined
    if (connector.agentId) {
      const { loadAgent } = await import('@/lib/server/agents/agent-repository')
      agent = (await loadAgent(connector.agentId)) ?? undefined
    }
    let walletAddressFallback = ''
    if (agent?.swarmdockWalletId) {
      const { loadWallet } = await import('@/lib/server/wallets/wallet-repository')
      walletAddressFallback = resolveSwarmDockWalletAddress(agent, loadWallet(agent.swarmdockWalletId))
    }

    const config = resolveSwarmDockConfig(connector, agent, walletAddressFallback)
    const connectorId = connector.id
    const agentId = connector.agentId || ''
    const privateKey = _botToken || ''

    if (!privateKey) throw new Error('SwarmDock connector requires an Ed25519 private key credential')
    if (!config.walletAddress) throw new Error('SwarmDock connector requires a Base L2 wallet address in config')

    // Dynamic import of the SDK
    let SwarmDockClient: typeof import('@swarmdock/sdk').SwarmDockClient
    let ConflictError: typeof import('@swarmdock/sdk').ConflictError
    let AuthenticationError: typeof import('@swarmdock/sdk').AuthenticationError
    try {
      const sdk = await import('@swarmdock/sdk')
      SwarmDockClient = sdk.SwarmDockClient
      ConflictError = sdk.ConflictError
      AuthenticationError = sdk.AuthenticationError
    } catch {
      throw new Error('SwarmDock SDK (@swarmdock/sdk) is not installed. Run: npm install @swarmdock/sdk')
    }

    const client = new SwarmDockClient({
      baseUrl: config.apiUrl,
      privateKey,
      ...(config.paymentPrivateKey?.startsWith('0x')
        ? { paymentPrivateKey: config.paymentPrivateKey as `0x${string}` }
        : {}),
    })

    const desiredProfile = buildDesiredSwarmDockProfile(connector, config, agent)

    log.info(TAG, `Registering agent "${connector.name}" on SwarmDock at ${config.apiUrl}`)
    try {
      const registration = await client.register({
        displayName: desiredProfile.displayName,
        description: desiredProfile.description,
        framework: desiredProfile.framework,
        modelProvider: desiredProfile.modelProvider,
        modelName: desiredProfile.modelName,
        walletAddress: desiredProfile.walletAddress,
        skills: desiredProfile.skills,
      })
      log.info(TAG, `Registered as ${registration.agent.did} (trust level ${registration.agent.trustLevel})`)
      await persistSwarmDockAgentBackfill(agent, registration.agent)

      logActivity({
        entityType: 'connector',
        entityId: connectorId,
        action: 'swarmdock-registered',
        actor: 'system',
        summary: `Agent "${connector.name}" registered on SwarmDock as ${registration.agent.did}`,
      })
    } catch (err) {
      if (err instanceof ConflictError) {
        log.info(TAG, `Agent already registered, authenticating`)
        await client.authenticate()
        const syncResult = await syncSwarmDockProfile(client, desiredProfile)
        await persistSwarmDockAgentBackfill(agent, syncResult.liveProfile)
        if (syncResult.updatedProfile || syncResult.updatedSkills) {
          log.info(
            TAG,
            `Synchronized live SwarmDock profile${syncResult.updatedProfile ? ' fields' : ''}${syncResult.updatedProfile && syncResult.updatedSkills ? ' and' : ''}${syncResult.updatedSkills ? ' skills' : ''}`,
          )
        }
      } else {
        throw err
      }
    }

    // Set up SSE event stream
    let alive = true

    const handleSSEEvent = async (event: SSEEvent) => {
      if (!alive) return
      try {
        switch (event.type) {
          case 'task.created':
          case 'task.invited': {
            if (!config.autoDiscover) break
            const task = event.data as unknown as Task
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
            const task = event.data as unknown as Task
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

          case 'task.review': {
            const taskId = (event.data as Record<string, string>).taskId
            if (taskId) await updateBoardTaskFromEvent(taskId, 'task.review')
            break
          }

          case 'task.disputed': {
            const taskId = (event.data as Record<string, string>).taskId
            if (taskId) {
              await updateBoardTaskFromEvent(taskId, 'task.disputed')
              logActivity({
                entityType: 'connector',
                entityId: connectorId,
                action: 'incident',
                actor: 'system',
                summary: `SwarmDock task ${taskId} disputed`,
              })
            }
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

          case 'escrow.releasing':
          case 'escrow.refunding': {
            const data = event.data as Record<string, string>
            logActivity({
              entityType: 'connector',
              entityId: connectorId,
              action: 'swarmdock-escrow',
              actor: 'system',
              summary: `Escrow ${event.type.split('.')[1]} for task ${data.taskId}`,
            })
            break
          }

          case 'escrow.release_failed':
          case 'escrow.refund_failed': {
            const data = event.data as Record<string, string>
            logActivity({
              entityType: 'connector',
              entityId: connectorId,
              action: 'incident',
              actor: 'system',
              summary: `Escrow ${event.type.replace('escrow.', '')} for task ${data.taskId}`,
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
        if (err instanceof AuthenticationError) {
          log.warn(TAG, 'SwarmDock token expired, re-authenticating')
          try { await client.authenticate() } catch {}
        } else {
          log.error(TAG, `SwarmDock heartbeat failed: ${err instanceof Error ? err.message : String(err)}`)
        }
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
