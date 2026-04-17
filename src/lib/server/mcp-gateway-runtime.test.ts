import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'node:test'
import type { McpServerConfig } from '@/types'
import {
  getPromoter,
  clearPromoter,
  recordDiscoveredTools,
  searchDiscoveredTools,
  shouldExposeMcpTool,
  SessionToolPromoter,
  type DiscoveredTool,
} from './mcp-gateway-runtime'

function baseServer(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'srv_1',
    name: 'fs',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'thing'],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

describe('SessionToolPromoter', () => {
  it('remembers promoted names', () => {
    const p = new SessionToolPromoter()
    assert.equal(p.allow('mcp_fs_read'), false)
    p.promote('mcp_fs_read')
    assert.equal(p.allow('mcp_fs_read'), true)
    assert.deepEqual(p.promoted(), ['mcp_fs_read'])
  })

  it('clears', () => {
    const p = new SessionToolPromoter()
    p.promoteMany(['a', 'b'])
    p.clear()
    assert.deepEqual(p.promoted(), [])
  })
})

describe('getPromoter', () => {
  it('returns a stable instance per sessionId', () => {
    const s1 = 'sess_' + Math.random().toString(36).slice(2)
    const s2 = 'sess_' + Math.random().toString(36).slice(2)
    const p1 = getPromoter(s1)
    const p2 = getPromoter(s2)
    const p1Again = getPromoter(s1)
    assert.equal(p1, p1Again)
    assert.notEqual(p1, p2)
    clearPromoter(s1)
    clearPromoter(s2)
  })
})

describe('shouldExposeMcpTool', () => {
  it('binds everything when alwaysExpose is undefined (back-compat)', () => {
    const server = baseServer()
    assert.equal(
      shouldExposeMcpTool({
        server,
        toolName: 'read',
        langChainName: 'mcp_fs_read',
      }),
      true,
    )
  })

  it('respects alwaysExpose: false unless promoted', () => {
    const server = baseServer({ alwaysExpose: false })
    assert.equal(
      shouldExposeMcpTool({
        server,
        toolName: 'read',
        langChainName: 'mcp_fs_read',
      }),
      false,
    )
    const promoter = new SessionToolPromoter()
    promoter.promote('mcp_fs_read')
    assert.equal(
      shouldExposeMcpTool({
        server,
        toolName: 'read',
        langChainName: 'mcp_fs_read',
        promoter,
      }),
      true,
    )
  })

  it('honors string[] allowlist by bare tool name', () => {
    const server = baseServer({ alwaysExpose: ['read'] })
    assert.equal(
      shouldExposeMcpTool({
        server,
        toolName: 'read',
        langChainName: 'mcp_fs_read',
      }),
      true,
    )
    assert.equal(
      shouldExposeMcpTool({
        server,
        toolName: 'write',
        langChainName: 'mcp_fs_write',
      }),
      false,
    )
  })

  it('per-agent mcpEagerTools overrides server policy', () => {
    const server = baseServer({ alwaysExpose: false })
    assert.equal(
      shouldExposeMcpTool({
        server,
        toolName: 'read',
        langChainName: 'mcp_fs_read',
        agentEagerTools: ['read'],
      }),
      true,
    )
  })
})

describe('searchDiscoveredTools', () => {
  const discovered: DiscoveredTool[] = [
    {
      name: 'read_file',
      langChainName: 'mcp_fs_read_file',
      description: 'Read a file from disk',
      serverId: 's1',
      serverName: 'fs',
    },
    {
      name: 'list_issues',
      langChainName: 'mcp_github_list_issues',
      description: 'List GitHub issues in a repository',
      serverId: 's2',
      serverName: 'github',
    },
    {
      name: 'run_sql',
      langChainName: 'mcp_db_run_sql',
      description: 'Execute a SQL query against Postgres',
      serverId: 's3',
      serverName: 'db',
    },
  ]

  beforeEach(() => {
    for (const t of discovered) {
      recordDiscoveredTools(t.serverId, [t])
    }
  })

  it('matches on bare tool name substring', () => {
    const matches = searchDiscoveredTools('read_file')
    assert.equal(matches[0]?.name, 'mcp_fs_read_file')
  })

  it('matches on description keywords', () => {
    const matches = searchDiscoveredTools('github issues')
    assert.equal(matches[0]?.name, 'mcp_github_list_issues')
  })

  it('returns empty for empty query', () => {
    assert.deepEqual(searchDiscoveredTools(''), [])
  })

  it('honors limit', () => {
    const matches = searchDiscoveredTools('read list run', 2)
    assert.ok(matches.length <= 2)
  })
})
