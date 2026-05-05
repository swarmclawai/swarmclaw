import assert from 'node:assert/strict'
import test from 'node:test'

import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

test('POST /api/portability/import validates manifest arrays before importing', () => {
  const output = runWithTempDataDir<{
    invalidStatus: number
    invalidError: string | null
    invalidPaths: string[]
    validStatus: number
    validAgentsCreated: number | null
    validSkillsCreated: number | null
    validSchedulesCreated: number | null
  }>(`
    const routeMod = await import('./src/app/api/portability/import/route')
    const route = routeMod.default || routeMod

    const invalidResponse = await route.POST(new Request('http://local/api/portability/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ formatVersion: 1, agents: [] }),
    }))
    const invalidPayload = await invalidResponse.json()

    const validResponse = await route.POST(new Request('http://local/api/portability/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        formatVersion: 1,
        exportedAt: '2026-03-29T00:00:00.000Z',
        agents: [],
        skills: [],
        schedules: [],
      }),
    }))
    const validPayload = await validResponse.json()

    console.log(JSON.stringify({
      invalidStatus: invalidResponse.status,
      invalidError: invalidPayload?.error || null,
      invalidPaths: Array.isArray(invalidPayload?.issues)
        ? invalidPayload.issues.map((issue) => issue.path).sort()
        : [],
      validStatus: validResponse.status,
      validAgentsCreated: validPayload?.agents?.created ?? null,
      validSkillsCreated: validPayload?.skills?.created ?? null,
      validSchedulesCreated: validPayload?.schedules?.created ?? null,
    }))
  `)

  assert.equal(output.invalidStatus, 400)
  assert.equal(output.invalidError, 'Validation failed')
  assert.deepEqual(output.invalidPaths, ['schedules', 'skills'])
  assert.equal(output.validStatus, 200)
  assert.equal(output.validAgentsCreated, 0)
  assert.equal(output.validSkillsCreated, 0)
  assert.equal(output.validSchedulesCreated, 0)
})

test('POST /api/portability/import preserves v2 bundle resources after validation', () => {
  const output = runWithTempDataDir<{
    status: number
    created: Record<string, number>
    projectId: string | null
    agentId: string | null
    agentProjectId: string | null
    agentSkillIds: string[]
    agentMcpServerIds: string[]
    agentGoalId: string | null
    skillId: string | null
    skillProjectId: string | null
    skillAgentIds: string[]
    scheduleProjectId: string | null
    scheduleParticipantIds: string[]
    scheduleFacilitatorId: string | null
    scheduleObserverIds: string[]
    chatroomId: string | null
    chatroomAgentIds: string[]
    connectorAgentId: string | null
    connectorChatroomId: string | null
    connectorEnabled: boolean | null
    mcpId: string | null
    mcpEnvKeys: string[]
    goalId: string | null
    goalProjectId: string | null
    goalAgentId: string | null
    needsCredentials: string[]
  }>(`
    const routeMod = await import('./src/app/api/portability/import/route')
    const storageMod = await import('./src/lib/server/storage')
    const agentRepoMod = await import('./src/lib/server/agents/agent-repository')
    const skillRepoMod = await import('./src/lib/server/skills/skill-repository')
    const scheduleRepoMod = await import('./src/lib/server/schedules/schedule-repository')
    const chatroomRepoMod = await import('./src/lib/server/chatrooms/chatroom-repository')
    const connectorRepoMod = await import('./src/lib/server/connectors/connector-repository')
    const route = routeMod.default || routeMod
    const storage = storageMod.default || storageMod
    const agentRepo = agentRepoMod.default || agentRepoMod
    const skillRepo = skillRepoMod.default || skillRepoMod
    const scheduleRepo = scheduleRepoMod.default || scheduleRepoMod
    const chatroomRepo = chatroomRepoMod.default || chatroomRepoMod
    const connectorRepo = connectorRepoMod.default || connectorRepoMod
    const { loadProjects, loadMcpServers, loadGoals } = storage
    const { loadAgents } = agentRepo
    const { loadSkills } = skillRepo
    const { loadSchedules } = scheduleRepo
    const { loadChatrooms } = chatroomRepo
    const { loadConnectors } = connectorRepo

    const response = await route.POST(new Request('http://local/api/portability/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        formatVersion: 2,
        exportedAt: '2026-05-05T00:00:00.000Z',
        scope: { kind: 'project', originalProjectId: 'project-1', projectName: 'Launch Room' },
        projects: [{
          originalId: 'project-1',
          name: 'Launch Room',
          description: 'Shipping workspace',
          objective: 'Ship the fix',
        }],
        skills: [{
          originalId: 'skill-1',
          originalProjectId: 'project-1',
          originalAgentIds: ['agent-1'],
          name: 'Release Skill',
          content: 'Ship carefully',
          scope: 'agent',
        }],
        mcpServers: [{
          originalId: 'mcp-1',
          name: 'Local Tools',
          transport: 'stdio',
          command: 'node',
          args: ['tool.js'],
          envKeys: ['API_TOKEN'],
          credentialsScrubbed: true,
        }],
        agents: [{
          originalId: 'agent-1',
          name: 'Release Lead',
          description: 'Owns launch execution',
          systemPrompt: 'Ship safely',
          provider: 'openai',
          model: 'gpt-4o-mini',
          projectId: 'project-1',
          skillIds: ['skill-1'],
          mcpServerIds: ['mcp-1'],
          goalId: 'goal-1',
        }],
        schedules: [{
          originalId: 'schedule-1',
          originalAgentId: 'agent-1',
          name: 'Launch Check',
          projectId: 'project-1',
          taskPrompt: 'Check release readiness',
          taskMode: 'protocol',
          protocolTemplateId: 'template-1',
          protocolParticipantAgentIds: ['agent-1'],
          protocolFacilitatorAgentId: 'agent-1',
          protocolObserverAgentIds: ['agent-1'],
          protocolConfig: { phase: 'ship' },
          scheduleType: 'interval',
          intervalMs: 60000,
        }],
        chatrooms: [{
          originalId: 'room-1',
          originalAgentIds: ['agent-1'],
          name: 'Launch Room Chat',
          chatMode: 'parallel',
          autoAddress: true,
          routingRules: [{
            type: 'keyword',
            keywords: ['release'],
            originalAgentId: 'agent-1',
            priority: 1,
          }],
        }],
        connectors: [{
          originalId: 'connector-1',
          originalAgentId: 'agent-1',
          originalChatroomId: 'room-1',
          name: 'Launch Slack',
          platform: 'slack',
          isEnabled: false,
          config: { channel: 'launch' },
          credentialsScrubbed: true,
        }],
        goals: [{
          originalId: 'goal-1',
          originalProjectId: 'project-1',
          originalAgentId: 'agent-1',
          title: 'Ship fix',
          level: 'project',
          objective: 'Release the portability fix',
          status: 'active',
        }],
        extensions: [{ name: 'builtin-checks' }],
      }),
    }))
    const payload = await response.json()
    const project = Object.values(loadProjects()).find((item) => item.name === 'Launch Room')
    const agent = Object.values(loadAgents()).find((item) => item.name === 'Release Lead')
    const skill = Object.values(loadSkills()).find((item) => item.name === 'Release Skill')
    const schedule = Object.values(loadSchedules()).find((item) => item.name === 'Launch Check')
    const chatroom = Object.values(loadChatrooms()).find((item) => item.name === 'Launch Room Chat')
    const connector = Object.values(loadConnectors()).find((item) => item.name === 'Launch Slack')
    const mcp = Object.values(loadMcpServers()).find((item) => item.name === 'Local Tools')
    const goal = Object.values(loadGoals()).find((item) => item.title === 'Ship fix')

    console.log(JSON.stringify({
      status: response.status,
      created: {
        agents: payload.agents.created,
        skills: payload.skills.created,
        schedules: payload.schedules.created,
        connectors: payload.connectors.created,
        chatrooms: payload.chatrooms.created,
        mcpServers: payload.mcpServers.created,
        projects: payload.projects.created,
        goals: payload.goals.created,
      },
      projectId: project?.id || null,
      agentId: agent?.id || null,
      agentProjectId: agent?.projectId || null,
      agentSkillIds: agent?.skillIds || [],
      agentMcpServerIds: agent?.mcpServerIds || [],
      agentGoalId: agent?.goalId || null,
      skillId: skill?.id || null,
      skillProjectId: skill?.projectId || null,
      skillAgentIds: skill?.agentIds || [],
      scheduleProjectId: schedule?.projectId || null,
      scheduleParticipantIds: schedule?.protocolParticipantAgentIds || [],
      scheduleFacilitatorId: schedule?.protocolFacilitatorAgentId || null,
      scheduleObserverIds: schedule?.protocolObserverAgentIds || [],
      chatroomId: chatroom?.id || null,
      chatroomAgentIds: chatroom?.agentIds || [],
      connectorAgentId: connector?.agentId || null,
      connectorChatroomId: connector?.chatroomId || null,
      connectorEnabled: connector?.isEnabled ?? null,
      mcpId: mcp?.id || null,
      mcpEnvKeys: Object.keys(mcp?.env || {}),
      goalId: goal?.id || null,
      goalProjectId: goal?.projectId || null,
      goalAgentId: goal?.agentId || null,
      needsCredentials: payload.mcpServers.needsCredentials,
    }))
  `)

  assert.equal(output.status, 200)
  assert.deepEqual(output.created, {
    agents: 1,
    skills: 1,
    schedules: 1,
    connectors: 1,
    chatrooms: 1,
    mcpServers: 1,
    projects: 1,
    goals: 1,
  })
  assert.equal(output.agentProjectId, output.projectId)
  assert.deepEqual(output.agentSkillIds, [output.skillId])
  assert.deepEqual(output.agentMcpServerIds, [output.mcpId])
  assert.equal(output.agentGoalId, output.goalId)
  assert.equal(output.skillProjectId, output.projectId)
  assert.deepEqual(output.skillAgentIds, [output.agentId])
  assert.equal(output.scheduleProjectId, output.projectId)
  assert.deepEqual(output.scheduleParticipantIds, [output.agentId])
  assert.equal(output.scheduleFacilitatorId, output.agentId)
  assert.deepEqual(output.scheduleObserverIds, [output.agentId])
  assert.deepEqual(output.chatroomAgentIds, [output.agentId])
  assert.equal(output.connectorAgentId, output.agentId)
  assert.equal(output.connectorChatroomId, output.chatroomId)
  assert.equal(output.connectorEnabled, false)
  assert.deepEqual(output.mcpEnvKeys, ['API_TOKEN'])
  assert.equal(output.goalProjectId, output.projectId)
  assert.equal(output.goalAgentId, output.agentId)
  assert.deepEqual(output.needsCredentials, ['Local Tools'])
})
