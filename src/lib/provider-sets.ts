/** CLI providers that use their own tool execution outside the shared tool-runtime path. */
export const NON_LANGGRAPH_PROVIDER_IDS = new Set(['claude-cli', 'codex-cli', 'opencode-cli'])

/** Providers with native tool/capability support (CLI providers + OpenClaw). */
export const NATIVE_CAPABILITY_PROVIDER_IDS = new Set(['claude-cli', 'codex-cli', 'opencode-cli', 'openclaw'])
