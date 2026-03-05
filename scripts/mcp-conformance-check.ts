#!/usr/bin/env node
import { loadMcpServers } from '../src/lib/server/storage'
import { runMcpConformanceCheck } from '../src/lib/server/mcp-conformance'
import type { McpServerConfig } from '../src/types'

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallback
}

function parseIntWithBounds(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

async function main() {
  const required = parseBool(process.env.SWARMCLAW_MCP_CONFORMANCE_REQUIRED, false)
  const failOnWarning = parseBool(process.env.SWARMCLAW_MCP_CONFORMANCE_FAIL_ON_WARNING, false)
  const timeoutMs = parseIntWithBounds(process.env.SWARMCLAW_MCP_CONFORMANCE_TIMEOUT_MS, 12_000, 1_000, 120_000)
  const smokeToolName = process.env.SWARMCLAW_MCP_CONFORMANCE_SMOKE_TOOL || undefined

  const servers = Object.values(loadMcpServers())
  if (servers.length === 0) {
    const message = '[mcp-conformance] No MCP servers configured.'
    if (required) {
      console.error(`${message} Set SWARMCLAW_MCP_CONFORMANCE_REQUIRED=0 to allow empty config.`)
      process.exitCode = 1
      return
    }
    console.log(`${message} Skipping.`)
    return
  }

  let totalErrors = 0
  let totalWarnings = 0

  for (const server of servers) {
    const result = await runMcpConformanceCheck(server as McpServerConfig, {
      timeoutMs,
      smokeToolName,
    })
    const errors = result.issues.filter((issue) => issue.level === 'error')
    const warnings = result.issues.filter((issue) => issue.level === 'warning')
    totalErrors += errors.length
    totalWarnings += warnings.length

    console.log(`[mcp-conformance] ${result.serverName} (${result.serverId}) -> ${result.ok ? 'PASS' : 'FAIL'} | tools=${result.toolsCount} | smoke=${result.smokeToolName || 'none'}`)
    if (result.issues.length > 0) {
      for (const issue of result.issues) {
        const scope = issue.toolName ? ` (${issue.toolName})` : ''
        console.log(`  - ${issue.level.toUpperCase()} [${issue.code}]${scope}: ${issue.message}`)
      }
    }
  }

  console.log(`[mcp-conformance] Summary: errors=${totalErrors}, warnings=${totalWarnings}`)
  if (totalErrors > 0 || (failOnWarning && totalWarnings > 0)) {
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('[mcp-conformance] Fatal error:', err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
