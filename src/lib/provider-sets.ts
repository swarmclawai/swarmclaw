/** CLI providers that use their own tool execution outside the shared tool-runtime path. */
export const NON_LANGGRAPH_PROVIDER_IDS = new Set(['claude-cli', 'codex-cli', 'opencode-cli', 'gemini-cli', 'copilot-cli'])

/** Providers with native tool/capability support (CLI providers + OpenClaw). */
export const NATIVE_CAPABILITY_PROVIDER_IDS = new Set(['claude-cli', 'codex-cli', 'opencode-cli', 'gemini-cli', 'copilot-cli', 'openclaw'])

/** Providers that can only act as workers — no coordinator role, no heartbeat, no advanced settings. */
export const WORKER_ONLY_PROVIDER_IDS = new Set(['claude-cli', 'codex-cli', 'opencode-cli', 'gemini-cli', 'copilot-cli', 'openclaw'])
