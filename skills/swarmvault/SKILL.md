---
name: swarmvault
description: Use when working with a SwarmVault knowledge vault (raw/, wiki/, swarmvault.schema.md). Establishes schema-first conventions and prefers graph queries over broad search.
homepage: https://swarmvault.ai
metadata:
  openclaw:
    capabilities: [knowledge-base, knowledge-graph, retrieval, vault]
    requires:
      bins: [npx]
---

# SwarmVault

Use when the agent has a SwarmVault MCP server enabled (transport `stdio`, command `npx -y @swarmvaultai/cli mcp`) pointed at a vault directory.

A SwarmVault workspace is a three-layer knowledge system:

- `raw/` — immutable source inputs (PDFs, transcripts, code, emails, URLs, sheets). Never edit.
- `wiki/` — generated markdown owned by the agent and the SwarmVault compiler. Pages carry frontmatter (`page_id`, `source_ids`, `node_ids`, `freshness`, `source_hashes`).
- `state/` — generated indexes, graphs, and approvals. Treat as opaque output of `compile`.

The vault contract lives in `swarmvault.schema.md` at the workspace root. The vault config lives in `swarmvault.config.json`.

## Rules

1. **Read `swarmvault.schema.md` first** before any compile or query work. It defines categories, naming, freshness rules, and grounding conventions for this specific vault.
2. **Read `wiki/graph/report.md` before broad file searching** when it exists; otherwise start with `wiki/index.md`. Both summarize the vault structure so you don't re-scan everything.
3. **Treat `raw/` as immutable.** Never edit, rename, or delete files there. New sources go through `ingest`.
4. **Treat `wiki/` as compiler-owned.** Edits should preserve frontmatter fields exactly: `page_id`, `source_ids`, `node_ids`, `freshness`, `source_hashes`. If those drift, the next `compile` will overwrite or flag the page.
5. **Prefer graph queries over grep/glob** for "how does X relate to Y" or "what depends on Z" questions. The vault's typed graph is more reliable than text search.
6. **Save high-value answers** to `wiki/outputs/` (use the `query` or `explore` tools) instead of leaving them only in chat. That way they become first-class vault content for next time.

## Tool Palette

The SwarmVault MCP server exposes the following tools (names are prefixed by SwarmClaw with `mcp_<sanitized server name>_`, e.g. `mcp_SwarmVault_query_vault`). Match the user's intent to the closest tool:

Vault inspection:
- `workspace_info` — return current vault paths and high-level counts. Use this first when you've never seen this vault.
- `list_sources` — list source manifests under `raw/`.
- `search_pages` — full-text search across compiled wiki pages.
- `read_page` — read a specific wiki page by its `wiki/`-relative path.

Graph (prefer over grep for relational questions):
- `graph_report` — machine-readable graph report and trust artifact. Read this before broad searching.
- `query_graph` — traverse the graph from search seeds without calling an LLM provider.
- `get_node` — explain a graph node, its page, community, neighbors, and group patterns.
- `get_neighbors` — neighbors of a node or page target.
- `get_hyperedges` — list graph hyperedges, optionally filtered.
- `shortest_path` — shortest path between two graph targets.
- `god_nodes` — highest-connectivity nodes (the vault's hubs).
- `blast_radius` — impact analysis: what depends on this file or module?

Question answering:
- `query_vault` — natural-language question against the vault. Returns grounded citations. Pass `save: true` to persist the answer to `wiki/outputs/`.

Ingest and maintenance:
- `ingest_input` — add a file path or URL to `raw/` and register it as a managed source.
- `compile_vault` — re-derive `wiki/` pages, graph, and search index. Run after ingest, after schema changes, or when freshness is stale.
- `lint_vault` — anti-drift and vault health checks.

If the MCP server is unavailable but the agent has a `shell` or `execute` tool, the same operations are available via `swarmvault <subcommand>` (or `npx -y @swarmvaultai/cli <subcommand>`) with the working directory set to the vault root.

## Workflow

For a fresh question against the vault:

1. Call `workspace_info` if you haven't already, then read `swarmvault.schema.md`. If `wiki/graph/report.md` or `wiki/index.md` exists, skim it.
2. Use `query_vault` (or `query_graph` / `get_node` / `shortest_path` for relational questions). Cite returned `source_ids` and `node_ids`.
3. If the answer reveals a gap, propose `ingest_input` for the missing source, then `compile_vault`.
4. Save the final answer with `query_vault` `save: true` so it becomes vault content under `wiki/outputs/`.

For a new source the user mentions:

1. `ingest_input` the file/URL.
2. `compile_vault` to derive new wiki pages, graph, and search index.
3. `lint_vault` to check frontmatter and links.
4. Skim the new pages in `wiki/sources/` and confirm provenance.

## Boundaries

- Don't run `compile` against an unreviewed change to `swarmvault.schema.md` — `lint` first.
- Don't promote candidate pages (`wiki/candidates/`) to `wiki/concepts/` or `wiki/entities/` without the user's confirmation; the approval flow exists for a reason.
- Don't push the vault graph to Neo4j or export to Obsidian without an explicit ask.
