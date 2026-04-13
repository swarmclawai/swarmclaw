/** CLI providers that use their own tool execution outside the shared tool-runtime path. */
export const NON_LANGGRAPH_PROVIDER_IDS = new Set(['claude-cli', 'codex-cli', 'opencode-cli', 'opencode-web', 'gemini-cli', 'copilot-cli', 'droid-cli', 'cursor-cli', 'qwen-code-cli'])

/** Providers that manage their own runtime/tool loop even when reached over an API endpoint. */
export const RUNTIME_MANAGED_PROVIDER_IDS = new Set(['hermes', 'goose'])

/** Providers with native tool/capability support (CLI providers + OpenClaw + Hermes). */
export const NATIVE_CAPABILITY_PROVIDER_IDS = new Set(['claude-cli', 'codex-cli', 'opencode-cli', 'gemini-cli', 'copilot-cli', 'droid-cli', 'cursor-cli', 'qwen-code-cli', 'goose', 'openclaw', 'hermes'])

/** Providers that can only act as workers — no coordinator role, no heartbeat, no advanced settings. */
export const WORKER_ONLY_PROVIDER_IDS = new Set(['claude-cli', 'codex-cli', 'opencode-cli', 'gemini-cli', 'copilot-cli', 'droid-cli', 'cursor-cli', 'qwen-code-cli', 'goose', 'openclaw', 'hermes'])
