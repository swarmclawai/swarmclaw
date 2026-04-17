import type { McpServerConfig } from '@/types'
import { hmrSingleton } from '@/lib/shared-utils'

/**
 * Gateway-style runtime for SwarmClaw's MCP integration. Mirrors the behavior
 * of `@swarmclawai/mcp-gateway`'s router (alwaysExpose filter + mcp_tool_search
 * meta-tool) but stays inside SwarmClaw — no external dep on mcp-core (yet).
 *
 * Once `@swarmclawai/mcp-core` is published to npm, the plan is:
 *   1. Add `@swarmclawai/mcp-core` to SwarmClaw's dependencies.
 *   2. Replace `SessionToolPromoter`, `searchDiscoveredTools`, and
 *      `shouldExposeMcpTool` with imports from mcp-core. The field names on
 *      `DownstreamTool` differ from `DiscoveredTool` (`prefixedName` vs
 *      `langChainName`) — add a thin adapter during migration.
 *   3. Keep the hmrSingleton `state` here; mcp-core provides primitives, but
 *      SwarmClaw still owns process-wide session-scoped storage.
 *
 * Contains two pieces of shared state, both HMR-safe:
 *   - `SessionToolPromoter` instances keyed by sessionId. The agent calls
 *     `mcp_tool_search` to promote a lazy tool by name; the next turn's tool
 *     bind picks up the promoted name via `isPromoted`.
 *   - A discovery cache keyed by MCP server id, so even lazy servers have
 *     their tool schemas known in-process for `mcp_tool_search` to match
 *     against without a cold connect.
 */

export interface DiscoveredTool {
  name: string // bare tool name as the downstream reported it
  langChainName: string // the `mcp_<server>_<tool>` name SwarmClaw binds it under
  description?: string
  inputSchema?: unknown
  serverId: string
  serverName: string
}

export class SessionToolPromoter {
  private readonly exposed = new Set<string>()
  allow(langChainName: string): boolean { return this.exposed.has(langChainName) }
  promote(langChainName: string): void { this.exposed.add(langChainName) }
  promoteMany(names: readonly string[]): void { for (const n of names) this.exposed.add(n) }
  promoted(): string[] { return Array.from(this.exposed) }
  clear(): void { this.exposed.clear() }
}

interface RuntimeState {
  promoters: Map<string, SessionToolPromoter>
  // serverId -> discovered tools (updated opportunistically when we connect)
  discovered: Map<string, DiscoveredTool[]>
}

const state = hmrSingleton<RuntimeState>('mcpGatewayRuntime', () => ({
  promoters: new Map<string, SessionToolPromoter>(),
  discovered: new Map<string, DiscoveredTool[]>(),
}))

export function getPromoter(sessionId: string): SessionToolPromoter {
  let p = state.promoters.get(sessionId)
  if (!p) {
    p = new SessionToolPromoter()
    state.promoters.set(sessionId, p)
  }
  return p
}

export function clearPromoter(sessionId: string): void {
  state.promoters.delete(sessionId)
}

export function recordDiscoveredTools(serverId: string, tools: DiscoveredTool[]): void {
  state.discovered.set(serverId, tools)
}

export function allDiscoveredTools(): DiscoveredTool[] {
  const out: DiscoveredTool[] = []
  for (const arr of state.discovered.values()) {
    for (const t of arr) out.push(t)
  }
  return out
}

/**
 * Decide whether a given tool, from a given server, should be bound on this
 * turn. Order of precedence:
 *   1. Per-agent eager allowlist (`mcpEagerTools`) — agent-scoped override
 *   2. Server-level `alwaysExpose`
 *      - true (default)  → bind
 *      - false           → skip unless promoted
 *      - string[]        → bind only if tool name is on the list
 *   3. Session promoter — if the agent has called `mcp_tool_search` this
 *      session and promoted this tool, bind it regardless of (2).
 */
export function shouldExposeMcpTool(opts: {
  server: McpServerConfig
  toolName: string
  langChainName: string
  agentEagerTools?: readonly string[] | null
  promoter?: SessionToolPromoter | null
}): boolean {
  const { server, toolName, langChainName, agentEagerTools, promoter } = opts
  if (agentEagerTools && agentEagerTools.includes(toolName)) return true
  if (agentEagerTools && agentEagerTools.includes(langChainName)) return true
  if (promoter?.allow(langChainName)) return true
  const mode = server.alwaysExpose
  if (mode === undefined || mode === true) return true
  if (mode === false) return false
  if (Array.isArray(mode)) return mode.includes(toolName)
  return true
}

export interface ToolSearchMatch {
  name: string // langChainName
  server: string
  description?: string
  score: number
}

export function searchDiscoveredTools(query: string, limit = 8): ToolSearchMatch[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const terms = q.split(/\s+/).filter((t) => t.length >= 2)
  const clamped = Math.max(1, Math.min(limit, 50))
  const scored = allDiscoveredTools().map((t): ToolSearchMatch => {
    const haystack = `${t.langChainName} ${t.description ?? ''}`.toLowerCase()
    let score = 0
    if (haystack.includes(q)) score += 0.6
    let termHits = 0
    for (const term of terms) if (haystack.includes(term)) termHits += 1
    if (terms.length) score += 0.4 * (termHits / terms.length)
    return {
      name: t.langChainName,
      server: t.serverName,
      description: t.description,
      score: Math.min(1, score),
    }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored.filter((m) => m.score > 0).slice(0, clamped)
}
