import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Agent } from '@/types'
import {
  isDelegationTaskPayload,
  resolveDelegatorAgentId,
  resolveManagedAgentAssignment,
  validateManagedAgentAssignment,
} from '@/lib/server/agents/agent-assignment'

const now = Date.now()
const agents: Record<string, Agent> = {
  molly: {
    id: 'molly',
    name: 'Molly',
    description: '',
    systemPrompt: '',
    provider: 'openai',
    model: 'gpt-4o',
    createdAt: now,
    updatedAt: now,
  },
  writer: {
    id: 'writer',
    name: 'Writer',
    description: '',
    systemPrompt: '',
    provider: 'openai',
    model: 'gpt-4o',
    createdAt: now,
    updatedAt: now,
  },
}

describe('resolveManagedAgentAssignment', () => {
  it('resolves explicit aliases to concrete agent ids', () => {
    const resolved = resolveManagedAgentAssignment({ assignee: 'Writer' }, agents, 'molly')
    assert.equal(resolved.agentId, 'writer')
    assert.equal(resolved.source, 'explicit')
  })

  it('resolves description-based delegation before scope checks', () => {
    const resolved = resolveManagedAgentAssignment(
      { description: 'Please delegate this to @Writer and let them handle the draft.' },
      agents,
      'molly',
    )
    assert.equal(resolved.agentId, 'writer')
    assert.equal(resolved.source, 'description')
  })
})

describe('validateManagedAgentAssignment', () => {
  it('blocks assigning another agent when scope is self', () => {
    const resolved = resolveManagedAgentAssignment({ assignee: 'writer' }, agents, 'molly')
    const error = validateManagedAgentAssignment({
      resourceLabel: 'tasks',
      agents,
      assignScope: 'self',
      currentAgentId: 'molly',
      targetAgentId: resolved.agentId,
      unresolvedReference: resolved.unresolvedReference,
    })
    assert.match(error || '', /only assign tasks to yourself/i)
  })

  it('allows self-assignment in self scope', () => {
    const resolved = resolveManagedAgentAssignment({ agentId: 'molly' }, agents, 'molly')
    const error = validateManagedAgentAssignment({
      resourceLabel: 'tasks',
      agents,
      assignScope: 'self',
      currentAgentId: 'molly',
      targetAgentId: resolved.agentId,
      unresolvedReference: resolved.unresolvedReference,
    })
    assert.equal(error, null)
  })

  it('rejects unknown explicit agent references', () => {
    const resolved = resolveManagedAgentAssignment({ agentId: 'missing-agent' }, agents, 'molly')
    const error = validateManagedAgentAssignment({
      resourceLabel: 'tasks',
      agents,
      assignScope: 'all',
      currentAgentId: 'molly',
      targetAgentId: resolved.agentId,
      unresolvedReference: resolved.unresolvedReference,
    })
    assert.match(error || '', /unknown agent "missing-agent"/i)
  })

  it('rejects self-delegation using resolved agent ids', () => {
    const payload = {
      agentId: 'molly',
      sourceType: 'delegation',
      delegatedByAgentId: 'Molly',
    }
    const resolved = resolveManagedAgentAssignment(payload, agents, 'molly')
    const error = validateManagedAgentAssignment({
      resourceLabel: 'tasks',
      agents,
      assignScope: 'all',
      currentAgentId: 'molly',
      targetAgentId: resolved.agentId,
      unresolvedReference: resolved.unresolvedReference,
      isDelegation: isDelegationTaskPayload(payload),
      delegatorAgentId: resolveDelegatorAgentId(payload, agents, 'molly'),
    })
    assert.match(error || '', /different agent id/i)
  })
})
