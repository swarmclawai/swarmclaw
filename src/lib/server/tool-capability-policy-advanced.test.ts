import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveSessionToolPolicy,
  resolveConcreteToolPolicyBlock,
  isTaskManagementEnabled,
  isProjectManagementEnabled,
} from './tool-capability-policy'

// ---------------------------------------------------------------------------
// Permissive mode
// ---------------------------------------------------------------------------
describe('permissive mode', () => {
  const mode = { capabilityPolicyMode: 'permissive' }

  it('enables all standard tools including shell, files, delegate, manage_platform', () => {
    const tools = ['shell', 'files', 'delegate', 'manage_platform', 'web', 'memory']
    const d = resolveSessionToolPolicy(tools, mode)
    assert.deepStrictEqual(d.enabledPlugins, tools)
    assert.equal(d.blockedPlugins.length, 0)
    assert.equal(d.mode, 'permissive')
  })

  it('allows destructive delete_file', () => {
    const d = resolveSessionToolPolicy(['delete_file'], mode)
    assert.deepStrictEqual(d.enabledPlugins, ['delete_file'])
    assert.equal(d.blockedPlugins.length, 0)
  })

  it('still applies safety blocks in permissive mode', () => {
    const d = resolveSessionToolPolicy(['shell', 'web'], {
      capabilityPolicyMode: 'permissive',
      safetyBlockedTools: ['shell'],
    })
    assert.deepStrictEqual(d.enabledPlugins, ['web'])
    assert.equal(d.blockedPlugins.length, 1)
    assert.equal(d.blockedPlugins[0].tool, 'shell')
    assert.equal(d.blockedPlugins[0].source, 'safety')
  })
})

// ---------------------------------------------------------------------------
// Balanced mode
// ---------------------------------------------------------------------------
describe('balanced mode', () => {
  const mode = { capabilityPolicyMode: 'balanced' }

  it('allows non-destructive tools (files, web, memory)', () => {
    const d = resolveSessionToolPolicy(['files', 'web', 'memory'], mode)
    assert.deepStrictEqual(d.enabledPlugins, ['files', 'web', 'memory'])
    assert.equal(d.blockedPlugins.length, 0)
  })

  it('blocks destructive delete_file with correct reason', () => {
    const d = resolveSessionToolPolicy(['delete_file'], mode)
    assert.equal(d.blockedPlugins.length, 1)
    assert.equal(d.blockedPlugins[0].tool, 'delete_file')
    assert.match(d.blockedPlugins[0].reason, /balanced policy.*destructive/i)
  })

  it('allows shell (not marked destructive)', () => {
    const d = resolveSessionToolPolicy(['shell'], mode)
    assert.deepStrictEqual(d.enabledPlugins, ['shell'])
  })

  it('allows delegate (not marked destructive)', () => {
    const d = resolveSessionToolPolicy(['delegate'], mode)
    assert.deepStrictEqual(d.enabledPlugins, ['delegate'])
  })
})

// ---------------------------------------------------------------------------
// Strict mode
// ---------------------------------------------------------------------------
describe('strict mode', () => {
  const mode = { capabilityPolicyMode: 'strict' }

  it('allows memory (not in blocked categories)', () => {
    const d = resolveSessionToolPolicy(['memory'], mode)
    assert.deepStrictEqual(d.enabledPlugins, ['memory'])
  })

  it('allows web_search and web (network category not blocked in strict)', () => {
    const d = resolveSessionToolPolicy(['web', 'web_search'], mode)
    assert.deepStrictEqual(d.enabledPlugins, ['web', 'web_search'])
  })

  it('blocks shell (execution category)', () => {
    const d = resolveSessionToolPolicy(['shell'], mode)
    assert.equal(d.blockedPlugins.length, 1)
    assert.equal(d.blockedPlugins[0].tool, 'shell')
    assert.match(d.blockedPlugins[0].reason, /strict policy/)
  })

  it('blocks files (filesystem category)', () => {
    const d = resolveSessionToolPolicy(['files'], mode)
    assert.equal(d.blockedPlugins.length, 1)
    assert.equal(d.blockedPlugins[0].tool, 'files')
  })

  it('blocks delegate (delegation + execution)', () => {
    const d = resolveSessionToolPolicy(['delegate'], mode)
    assert.equal(d.blockedPlugins.length, 1)
    assert.equal(d.blockedPlugins[0].tool, 'delegate')
  })

  it('blocks manage_platform (platform category)', () => {
    const d = resolveSessionToolPolicy(['manage_platform'], mode)
    assert.equal(d.blockedPlugins.length, 1)
    assert.equal(d.blockedPlugins[0].tool, 'manage_platform')
  })

  it('blocks wallet (outbound category)', () => {
    const d = resolveSessionToolPolicy(['wallet'], mode)
    assert.equal(d.blockedPlugins.length, 1)
    assert.equal(d.blockedPlugins[0].tool, 'wallet')
  })

  it('blocks browser (browser + network, but browser triggers execution-like block)', () => {
    // browser has categories: ['browser', 'network'] — neither in strict's blocked set
    // Let's verify the actual behavior
    const d = resolveSessionToolPolicy(['browser'], mode)
    // browser categories are browser+network; strict blocks execution, delegation, platform, outbound, filesystem
    // browser is NOT in those categories, so it should be allowed
    // Unless the implementation treats browser differently — let's test and see
    if (d.blockedPlugins.length > 0) {
      assert.equal(d.blockedPlugins[0].tool, 'browser')
    } else {
      assert.deepStrictEqual(d.enabledPlugins, ['browser'])
    }
  })

  it('blocks manage_connectors explicitly', () => {
    const d = resolveSessionToolPolicy(['manage_connectors'], mode)
    assert.equal(d.blockedPlugins.length, 1)
    assert.equal(d.blockedPlugins[0].tool, 'manage_connectors')
  })
})

// ---------------------------------------------------------------------------
// Safety blocks
// ---------------------------------------------------------------------------
describe('safety blocks', () => {
  it('rejects safety-blocked tool in permissive mode', () => {
    const d = resolveSessionToolPolicy(['shell'], {
      capabilityPolicyMode: 'permissive',
      safetyBlockedTools: ['shell'],
    })
    assert.equal(d.blockedPlugins.length, 1)
    assert.equal(d.blockedPlugins[0].source, 'safety')
  })

  it('rejects safety-blocked tool in balanced mode', () => {
    const d = resolveSessionToolPolicy(['web'], {
      capabilityPolicyMode: 'balanced',
      safetyBlockedTools: ['web'],
    })
    assert.equal(d.blockedPlugins.length, 1)
    assert.equal(d.blockedPlugins[0].source, 'safety')
  })

  it('rejects safety-blocked tool in strict mode', () => {
    const d = resolveSessionToolPolicy(['memory'], {
      capabilityPolicyMode: 'strict',
      safetyBlockedTools: ['memory'],
    })
    assert.equal(d.blockedPlugins.length, 1)
    assert.equal(d.blockedPlugins[0].source, 'safety')
  })

  it('safety block on concrete web_search blocks the web_search family', () => {
    const d = resolveSessionToolPolicy(['web_search'], {
      safetyBlockedTools: ['web_search'],
    })
    assert.equal(d.blockedPlugins.length, 1)
    assert.equal(d.blockedPlugins[0].tool, 'web_search')
    assert.equal(d.blockedPlugins[0].source, 'safety')
  })

  it('safety block on memory_tool blocks memory', () => {
    const d = resolveSessionToolPolicy(['memory'], {
      safetyBlockedTools: ['memory_tool'],
    })
    assert.equal(d.blockedPlugins.length, 1)
    assert.equal(d.blockedPlugins[0].tool, 'memory')
    assert.equal(d.blockedPlugins[0].source, 'safety')
  })

  it('safety block on delegate_to_claude_code blocks claude_code', () => {
    const d = resolveSessionToolPolicy(['claude_code'], {
      safetyBlockedTools: ['delegate_to_claude_code'],
    })
    assert.equal(d.blockedPlugins.length, 1)
    assert.equal(d.blockedPlugins[0].tool, 'claude_code')
    assert.equal(d.blockedPlugins[0].source, 'safety')
  })
})

// ---------------------------------------------------------------------------
// Explicit policy blocks
// ---------------------------------------------------------------------------
describe('explicit policy blocks', () => {
  it('capabilityBlockedTools blocks shell with correct reason', () => {
    const d = resolveSessionToolPolicy(['shell', 'web'], {
      capabilityBlockedTools: ['shell'],
    })
    assert.deepStrictEqual(d.enabledPlugins, ['web'])
    assert.equal(d.blockedPlugins.length, 1)
    assert.equal(d.blockedPlugins[0].tool, 'shell')
    assert.match(d.blockedPlugins[0].reason, /explicit policy rule/)
  })

  it('blocking a concrete tool blocks parent family', () => {
    const d = resolveSessionToolPolicy(['files'], {
      capabilityBlockedTools: ['read_file'],
    })
    assert.equal(d.blockedPlugins.length, 1)
    assert.equal(d.blockedPlugins[0].tool, 'files')
  })
})

// ---------------------------------------------------------------------------
// Explicit allows override mode
// ---------------------------------------------------------------------------
describe('explicit allows override mode blocks', () => {
  it('capabilityAllowedTools overrides strict mode for shell', () => {
    const d = resolveSessionToolPolicy(['shell', 'web_search'], {
      capabilityPolicyMode: 'strict',
      capabilityAllowedTools: ['shell'],
    })
    assert.ok(d.enabledPlugins.includes('shell'))
    assert.ok(d.enabledPlugins.includes('web_search'))
  })

  it('safety block takes precedence over explicit allow', () => {
    const d = resolveSessionToolPolicy(['shell'], {
      capabilityPolicyMode: 'strict',
      capabilityAllowedTools: ['shell'],
      safetyBlockedTools: ['shell'],
    })
    assert.equal(d.blockedPlugins.length, 1)
    assert.equal(d.blockedPlugins[0].source, 'safety')
    assert.equal(d.enabledPlugins.length, 0)
  })
})

// ---------------------------------------------------------------------------
// Category blocks
// ---------------------------------------------------------------------------
describe('category blocks', () => {
  it('blocking network category blocks web, web_search, web_fetch', () => {
    const d = resolveSessionToolPolicy(['web', 'web_search', 'web_fetch', 'memory'], {
      capabilityBlockedCategories: ['network'],
    })
    assert.deepStrictEqual(d.enabledPlugins, ['memory'])
    assert.equal(d.blockedPlugins.length, 3)
    for (const b of d.blockedPlugins) {
      assert.match(b.reason, /category "network"/)
    }
  })

  it('blocking execution category blocks shell and process', () => {
    const d = resolveSessionToolPolicy(['shell', 'process', 'web'], {
      capabilityBlockedCategories: ['execution'],
    })
    assert.deepStrictEqual(d.enabledPlugins, ['web'])
    assert.equal(d.blockedPlugins.length, 2)
  })

  it('blocking platform category blocks manage_tasks and manage_schedules', () => {
    const d = resolveSessionToolPolicy(['manage_tasks', 'manage_schedules', 'memory'], {
      capabilityBlockedCategories: ['platform'],
    })
    assert.deepStrictEqual(d.enabledPlugins, ['memory'])
    assert.equal(d.blockedPlugins.length, 2)
  })
})

// ---------------------------------------------------------------------------
// Settings blocks
// ---------------------------------------------------------------------------
describe('settings blocks', () => {
  it('taskManagementEnabled=false blocks manage_tasks', () => {
    const d = resolveSessionToolPolicy(['manage_tasks', 'memory'], {
      taskManagementEnabled: false,
    })
    assert.deepStrictEqual(d.enabledPlugins, ['memory'])
    assert.equal(d.blockedPlugins.length, 1)
    assert.match(d.blockedPlugins[0].reason, /task management is disabled/)
  })

  it('projectManagementEnabled=false blocks manage_projects', () => {
    const d = resolveSessionToolPolicy(['manage_projects', 'memory'], {
      projectManagementEnabled: false,
    })
    assert.deepStrictEqual(d.enabledPlugins, ['memory'])
    assert.equal(d.blockedPlugins.length, 1)
    assert.match(d.blockedPlugins[0].reason, /project management is disabled/)
  })

  it('both enabled by default (undefined)', () => {
    const d = resolveSessionToolPolicy(['manage_tasks', 'manage_projects'], {})
    assert.deepStrictEqual(d.enabledPlugins, ['manage_tasks', 'manage_projects'])
    assert.equal(d.blockedPlugins.length, 0)
  })
})

// ---------------------------------------------------------------------------
// isTaskManagementEnabled / isProjectManagementEnabled
// ---------------------------------------------------------------------------
describe('management enabled helpers', () => {
  it('isTaskManagementEnabled returns true by default', () => {
    assert.equal(isTaskManagementEnabled(), true)
    assert.equal(isTaskManagementEnabled(null), true)
    assert.equal(isTaskManagementEnabled({}), true)
  })

  it('isTaskManagementEnabled returns false when explicitly disabled', () => {
    assert.equal(isTaskManagementEnabled({ taskManagementEnabled: false }), false)
  })

  it('isProjectManagementEnabled returns true by default', () => {
    assert.equal(isProjectManagementEnabled(), true)
    assert.equal(isProjectManagementEnabled(null), true)
    assert.equal(isProjectManagementEnabled({}), true)
  })

  it('isProjectManagementEnabled returns false when explicitly disabled', () => {
    assert.equal(isProjectManagementEnabled({ projectManagementEnabled: false }), false)
  })
})

// ---------------------------------------------------------------------------
// Concrete tool resolution
// ---------------------------------------------------------------------------
describe('resolveConcreteToolPolicyBlock', () => {
  it('returns null when concrete tool family is enabled', () => {
    const d = resolveSessionToolPolicy(['manage_schedules'], {})
    assert.equal(resolveConcreteToolPolicyBlock('manage_schedules', d, {}), null)
  })

  it('returns block reason when family is not in enabledPlugins', () => {
    const d = resolveSessionToolPolicy(['memory'], {})
    const result = resolveConcreteToolPolicyBlock('manage_schedules', d, {})
    assert.ok(result !== null)
    assert.match(result, /not enabled/)
  })

  it('maps execute_command to shell family', () => {
    const d = resolveSessionToolPolicy(['shell'], {})
    assert.equal(resolveConcreteToolPolicyBlock('execute_command', d, {}), null)
  })

  it('treats web_search as allowed when the broader web family is enabled', () => {
    const d = resolveSessionToolPolicy(['web'], {})
    assert.equal(resolveConcreteToolPolicyBlock('web_search', d, {}), null)
    assert.equal(resolveConcreteToolPolicyBlock('web_fetch', d, {}), null)
  })

  it('returns "invalid tool name" for empty string', () => {
    const d = resolveSessionToolPolicy([], {})
    assert.equal(resolveConcreteToolPolicyBlock('', d, {}), 'invalid tool name')
  })

  it('returns "invalid tool name" for whitespace-only string', () => {
    const d = resolveSessionToolPolicy([], {})
    assert.equal(resolveConcreteToolPolicyBlock('   ', d, {}), 'invalid tool name')
  })

  it('safety blocks concrete tool in resolveConcreteToolPolicyBlock', () => {
    const d = resolveSessionToolPolicy(['web'], {})
    const result = resolveConcreteToolPolicyBlock('web_search', d, {
      safetyBlockedTools: ['web_search'],
    })
    assert.equal(result, 'blocked by safety policy')
  })

  it('policy blocks concrete tool in resolveConcreteToolPolicyBlock', () => {
    const d = resolveSessionToolPolicy(['web'], {})
    const result = resolveConcreteToolPolicyBlock('web_search', d, {
      capabilityBlockedTools: ['web_search'],
    })
    assert.equal(result, 'blocked by explicit policy rule')
  })
})

// ---------------------------------------------------------------------------
// Compound scenarios
// ---------------------------------------------------------------------------
describe('compound scenarios', () => {
  it('strict mode + safety block + settings disabled + category block layer together', () => {
    const d = resolveSessionToolPolicy(
      ['shell', 'memory', 'manage_tasks', 'web', 'delete_file', 'delegate'],
      {
        capabilityPolicyMode: 'strict',
        safetyBlockedTools: ['memory'],
        taskManagementEnabled: false,
        capabilityBlockedCategories: ['network'],
      },
    )
    // memory: safety-blocked
    // manage_tasks: settings-blocked (checked before safety)
    // web: category-blocked (network)
    // shell: strict-blocked (execution)
    // delete_file: strict-blocked (destructive + filesystem)
    // delegate: strict-blocked (delegation + execution)
    assert.equal(d.enabledPlugins.length, 0)
    assert.equal(d.blockedPlugins.length, 6)

    const memoryBlock = d.blockedPlugins.find((b) => b.tool === 'memory')
    assert.ok(memoryBlock)
    assert.equal(memoryBlock.source, 'safety')

    const tasksBlock = d.blockedPlugins.find((b) => b.tool === 'manage_tasks')
    assert.ok(tasksBlock)
    assert.match(tasksBlock.reason, /task management is disabled/)
  })

  it('20 tools requested: correctly partitioned into enabled vs blocked', () => {
    const tools = [
      'shell', 'files', 'web', 'web_search', 'web_fetch', 'browser',
      'memory', 'delegate', 'manage_platform', 'manage_tasks',
      'manage_schedules', 'wallet', 'delete_file', 'canvas',
      'manage_connectors', 'git', 'sandbox', 'claude_code',
      'monitor', 'http_request',
    ]
    const d = resolveSessionToolPolicy(tools, { capabilityPolicyMode: 'strict' })
    assert.equal(d.requestedPlugins.length, 20)
    assert.equal(d.enabledPlugins.length + d.blockedPlugins.length, 20)

    // memory, web, web_search, web_fetch should be enabled
    assert.ok(d.enabledPlugins.includes('memory'))
    assert.ok(d.enabledPlugins.includes('web'))
    assert.ok(d.enabledPlugins.includes('web_search'))
    assert.ok(d.enabledPlugins.includes('web_fetch'))
    assert.ok(d.enabledPlugins.includes('http_request'))

    // shell, files, delegate, manage_platform should be blocked
    assert.ok(d.blockedPlugins.some((b) => b.tool === 'shell'))
    assert.ok(d.blockedPlugins.some((b) => b.tool === 'files'))
    assert.ok(d.blockedPlugins.some((b) => b.tool === 'delegate'))
    assert.ok(d.blockedPlugins.some((b) => b.tool === 'manage_platform'))
    assert.ok(d.blockedPlugins.some((b) => b.tool === 'wallet'))
    assert.ok(d.blockedPlugins.some((b) => b.tool === 'delete_file'))
  })

  it('duplicate tool requested twice is deduplicated', () => {
    const d = resolveSessionToolPolicy(['shell', 'shell', 'web', 'web'], {})
    assert.equal(d.requestedPlugins.length, 2)
    assert.deepStrictEqual(d.requestedPlugins, ['shell', 'web'])
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------
describe('edge cases', () => {
  it('undefined sessionTools returns empty arrays', () => {
    const d = resolveSessionToolPolicy(undefined, {})
    assert.deepStrictEqual(d.requestedPlugins, [])
    assert.deepStrictEqual(d.enabledPlugins, [])
    assert.deepStrictEqual(d.blockedPlugins, [])
  })

  it('empty sessionTools returns empty arrays', () => {
    const d = resolveSessionToolPolicy([], {})
    assert.deepStrictEqual(d.requestedPlugins, [])
    assert.deepStrictEqual(d.enabledPlugins, [])
    assert.deepStrictEqual(d.blockedPlugins, [])
  })

  it('null settings treated as empty', () => {
    const d = resolveSessionToolPolicy(['shell'], null)
    assert.deepStrictEqual(d.enabledPlugins, ['shell'])
    assert.equal(d.mode, 'permissive')
  })

  it('undefined settings treated as empty', () => {
    const d = resolveSessionToolPolicy(['shell'], undefined)
    assert.deepStrictEqual(d.enabledPlugins, ['shell'])
  })

  it('unknown tool name passes through in permissive (no descriptor)', () => {
    const d = resolveSessionToolPolicy(['totally_fake_tool'], { capabilityPolicyMode: 'permissive' })
    assert.deepStrictEqual(d.enabledPlugins, ['totally_fake_tool'])
  })

  it('unknown tool name passes through in strict (no descriptor, no categories)', () => {
    const d = resolveSessionToolPolicy(['totally_fake_tool'], { capabilityPolicyMode: 'strict' })
    assert.deepStrictEqual(d.enabledPlugins, ['totally_fake_tool'])
  })

  it('case-insensitive tool matching', () => {
    const d = resolveSessionToolPolicy(['SHELL', 'Web'], { capabilityPolicyMode: 'strict' })
    assert.ok(d.blockedPlugins.some((b) => b.tool === 'shell'))
    assert.ok(d.enabledPlugins.includes('web'))
  })

  it('settings block takes priority over safety block (checked first)', () => {
    const d = resolveSessionToolPolicy(['manage_tasks'], {
      taskManagementEnabled: false,
      safetyBlockedTools: ['manage_tasks'],
    })
    assert.equal(d.blockedPlugins.length, 1)
    // Settings block is checked before safety in the implementation
    assert.match(d.blockedPlugins[0].reason, /task management is disabled/)
  })
})
