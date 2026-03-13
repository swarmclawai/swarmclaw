import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildSessionTools } from './index'

describe('spawn_subagent runtime access', () => {
  it('hides spawn_subagent unless delegation is enabled', async () => {
    const built = await buildSessionTools(process.cwd(), ['spawn_subagent'], {
      sessionId: 'subagent-disabled-session',
      agentId: 'subagent-disabled-agent',
      delegationEnabled: false,
      delegationTargetMode: 'all',
      delegationTargetAgentIds: [],
    })

    try {
      assert.equal(
        built.tools.some((tool) => tool.name === 'spawn_subagent'),
        false,
      )
    } finally {
      await built.cleanup()
    }
  })

  it('rejects spawn_subagent targets outside the selected delegate list', async () => {
    const built = await buildSessionTools(process.cwd(), ['spawn_subagent'], {
      sessionId: 'subagent-selected-session',
      agentId: 'subagent-selected-agent',
      delegationEnabled: true,
      delegationTargetMode: 'selected',
      delegationTargetAgentIds: ['allowed-agent'],
    })

    try {
      const tool = built.tools.find((entry) => entry.name === 'spawn_subagent')
      assert.ok(tool, 'spawn_subagent should be available when delegation is enabled')

      const raw = await tool!.invoke({
        action: 'start',
        agentId: 'blocked-agent',
        message: 'hello',
      })

      assert.match(String(raw), /not in the allowed delegate agent list/i)
    } finally {
      await built.cleanup()
    }
  })
})
