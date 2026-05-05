import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { GET } from './route'
import { buildPortableExportFilename } from '@/lib/server/portability/export'
import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

describe('GET /api/portability/export', () => {
  it('returns a collision-resistant attachment filename for downloads', async () => {
    const response = await GET(new Request('http://local/api/portability/export?download=true'))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
    const disposition = response.headers.get('content-disposition') || ''
    assert.match(disposition, /^attachment; filename="swarmclaw-export-\d{8}-\d{6}\d{3}Z\.json"$/)
    const body = await response.json()
    assert.equal(disposition, `attachment; filename="${buildPortableExportFilename(body)}"`)
  })

  it('exports a scoped project bundle with scrubbed integrations', () => {
    const output = runWithTempDataDir<{
      status: number
      disposition: string
      scopeKind: string
      projectNames: string[]
      agentNames: string[]
      skillNames: string[]
      scheduleNames: string[]
      chatroomNames: string[]
      connectorNames: string[]
      mcpServerNames: string[]
      connectorConfig: Record<string, string>
      connectorEnabled: boolean
      missingStatus: number
      missingError: string
    }>(`
      const storageMod = await import('./src/lib/server/storage')
      const agentRepoMod = await import('./src/lib/server/agents/agent-repository')
      const skillRepoMod = await import('./src/lib/server/skills/skill-repository')
      const scheduleRepoMod = await import('./src/lib/server/schedules/schedule-repository')
      const chatroomRepoMod = await import('./src/lib/server/chatrooms/chatroom-repository')
      const connectorRepoMod = await import('./src/lib/server/connectors/connector-repository')
      const routeMod = await import('./src/app/api/portability/export/route')
      const storage = storageMod.default || storageMod
      const agentRepo = agentRepoMod.default || agentRepoMod
      const skillRepo = skillRepoMod.default || skillRepoMod
      const scheduleRepo = scheduleRepoMod.default || scheduleRepoMod
      const chatroomRepo = chatroomRepoMod.default || chatroomRepoMod
      const connectorRepo = connectorRepoMod.default || connectorRepoMod
      const route = routeMod.default || routeMod
      const { saveProjects, saveMcpServers } = storage
      const { saveAgents } = agentRepo
      const { saveSkills } = skillRepo
      const { saveSchedules } = scheduleRepo
      const { upsertChatroom } = chatroomRepo
      const { upsertConnector } = connectorRepo
      const now = 1780000000000

      saveProjects({
        'project-a': {
          id: 'project-a',
          name: 'Launch Room',
          description: 'Shipping workspace',
          color: '#5b8def',
          objective: 'Ship the next release',
          createdAt: now,
          updatedAt: now,
        },
        'project-b': {
          id: 'project-b',
          name: 'Backlog',
          description: 'Separate workspace',
          createdAt: now,
          updatedAt: now,
        },
      })
      saveSkills({
        'skill-a': {
          id: 'skill-a',
          name: 'Release Notes',
          filename: 'release-notes.md',
          content: 'Summarize shipped changes',
          projectId: 'project-a',
          scope: 'global',
          createdAt: now,
          updatedAt: now,
        },
        'global-skill': {
          id: 'global-skill',
          name: 'Risk Scan',
          filename: 'risk-scan.md',
          content: 'Find release risks',
          scope: 'global',
          createdAt: now,
          updatedAt: now,
        },
        'skill-b': {
          id: 'skill-b',
          name: 'Backlog Grooming',
          filename: 'backlog-grooming.md',
          content: 'Sort the backlog',
          projectId: 'project-b',
          scope: 'global',
          createdAt: now,
          updatedAt: now,
        },
      })
      saveMcpServers({
        'mcp-a': {
          id: 'mcp-a',
          name: 'Local Tools',
          transport: 'stdio',
          command: 'node',
          args: ['tool.js'],
          env: { API_TOKEN: 'secret-token' },
          createdAt: now,
          updatedAt: now,
        },
        'mcp-b': {
          id: 'mcp-b',
          name: 'Backlog Tools',
          transport: 'stdio',
          command: 'node',
          createdAt: now,
          updatedAt: now,
        },
      })
      saveAgents({
        'agent-a': {
          id: 'agent-a',
          name: 'Release Lead',
          description: 'Owns launch execution',
          systemPrompt: 'Ship safely',
          provider: 'openai',
          model: 'gpt-4o-mini',
          projectId: 'project-a',
          skillIds: ['skill-a', 'global-skill'],
          mcpServerIds: ['mcp-a'],
          createdAt: now,
          updatedAt: now,
        },
        'agent-b': {
          id: 'agent-b',
          name: 'Backlog Lead',
          description: 'Owns backlog',
          systemPrompt: 'Plan later',
          provider: 'openai',
          model: 'gpt-4o-mini',
          projectId: 'project-b',
          skillIds: ['skill-b'],
          mcpServerIds: ['mcp-b'],
          createdAt: now,
          updatedAt: now,
        },
      })
      saveSchedules({
        'schedule-a': {
          id: 'schedule-a',
          name: 'Daily Launch Check',
          agentId: 'agent-a',
          projectId: 'project-a',
          taskPrompt: 'Check release readiness',
          scheduleType: 'interval',
          intervalMs: 60000,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        },
        'schedule-b': {
          id: 'schedule-b',
          name: 'Backlog Check',
          agentId: 'agent-b',
          projectId: 'project-b',
          taskPrompt: 'Review backlog',
          scheduleType: 'interval',
          intervalMs: 60000,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        },
      })
      upsertChatroom('room-a', {
        id: 'room-a',
        name: 'Launch Room Chat',
        agentIds: ['agent-a'],
        messages: [],
        chatMode: 'parallel',
        temporary: false,
        createdAt: now,
        updatedAt: now,
      })
      upsertConnector('connector-a', {
        id: 'connector-a',
        name: 'Launch Slack',
        platform: 'slack',
        agentId: 'agent-a',
        chatroomId: 'room-a',
        credentialId: 'credential-a',
        config: { channel: 'launch', botToken: 'secret-token' },
        isEnabled: true,
        status: 'running',
        createdAt: now,
        updatedAt: now,
      })

      const response = await route.GET(new Request('http://local/api/portability/export?projectId=project-a&download=true'))
      const body = await response.json()
      const missingResponse = await route.GET(new Request('http://local/api/portability/export?projectId=missing-project'))
      const missingPayload = await missingResponse.json()
      console.log(JSON.stringify({
        status: response.status,
        disposition: response.headers.get('content-disposition') || '',
        scopeKind: body.scope?.kind || null,
        projectNames: (body.projects || []).map((project) => project.name),
        agentNames: body.agents.map((agent) => agent.name),
        skillNames: body.skills.map((skill) => skill.name).sort(),
        scheduleNames: body.schedules.map((schedule) => schedule.name),
        chatroomNames: (body.chatrooms || []).map((chatroom) => chatroom.name),
        connectorNames: (body.connectors || []).map((connector) => connector.name),
        mcpServerNames: (body.mcpServers || []).map((server) => server.name),
        connectorConfig: body.connectors?.[0]?.config || {},
        connectorEnabled: body.connectors?.[0]?.isEnabled ?? null,
        missingStatus: missingResponse.status,
        missingError: missingPayload.error,
      }))
    `)

    assert.equal(output.status, 200)
    assert.match(output.disposition, /^attachment; filename="swarmclaw-project-launch-room-\d{8}-\d{6}\d{3}Z\.json"$/)
    assert.equal(output.scopeKind, 'project')
    assert.deepEqual(output.projectNames, ['Launch Room'])
    assert.deepEqual(output.agentNames, ['Release Lead'])
    assert.deepEqual(output.skillNames, ['Release Notes', 'Risk Scan'])
    assert.deepEqual(output.scheduleNames, ['Daily Launch Check'])
    assert.deepEqual(output.chatroomNames, ['Launch Room Chat'])
    assert.deepEqual(output.connectorNames, ['Launch Slack'])
    assert.deepEqual(output.mcpServerNames, ['Local Tools'])
    assert.deepEqual(output.connectorConfig, { channel: 'launch' })
    assert.equal(output.connectorEnabled, false)
    assert.equal(output.missingStatus, 404)
    assert.equal(output.missingError, 'Project not found: missing-project')
  })
})
