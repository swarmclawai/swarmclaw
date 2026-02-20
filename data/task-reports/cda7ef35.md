# Task cda7ef35: Fix thinking/reasoning text leaking into outbound connector messages

- Status: completed
- Agent: fcd98bac
- Session: bd0ef5ca

## Description
Bug: Agent internal planning text (e.g. "Let me check...", "Checking git log:", etc.) is getting concatenated and sent to users via WhatsApp. The user receives crazy long messages with all the agent's thinking loops. Only the final response should be delivered to connectors, not the internal reasoning steps. Need to sanitize responses before they hit connector_message_tool or connector delivery layer. Check message assembly in routeMessage, streamAgentChat response handling, and connector send paths.

## Result Summary
Here's a summary of the fix:

**Root cause**: In `stream-agent-chat.ts`, the LangGraph ReAct agent loop fires `on_chat_model_stream` for every LLM turn — including intermediate turns where the agent outputs planning text ("Let me check...", "Checking git log:") before making tool calls. All of this text was concatenated into `fullText` and returned as a single string. When `routeMessage` in `manager.ts` sent this to WhatsApp, the user received the entire internal reasoning chain as one giant message.

**Fix** (3 files):

1. **`stream-agent-chat.ts`** — Track a `lastSegment` variable alongside `fullText`. Reset `lastSegment` to `''` on every `on_tool_start` event (since preceding text was intermediate planning). Return a `{ fullText, finalResponse }` object where `finalResponse` is the text from only the last LLM turn (after all tool calls complete). Falls back to `fullText` if the last segment is empty.

2. **`connectors/manager.ts`** — `routeMessage` now uses `result.finalResponse` instead of the full concatenated text. Only the agent's actual answer gets delivered to WhatsApp/Discord/Telegram/Slack.

3. **`chat-execution.ts`** — Web UI caller uses `.fullText` to preserve existing behavior (SSE already streams everything live, and the full text is saved for session history replay).

## Changed Files
- **Root cause**: In `stream-agent-chat.ts`, the LangGraph ReAct agent loop fires `on_chat_model_stream` for every LLM turn — including intermediate turns where the agent outputs planning text ("Let me check...", "Checking git log:") before making tool calls. All of this text was concatenated into `fullText` and returned as a single string. When `routeMessage` in `manager.ts` sent this to WhatsApp, the user received the entire internal reasoning chain as one giant message.
- 1. **`stream-agent-chat.ts`** — Track a `lastSegment` variable alongside `fullText`. Reset `lastSegment` to `''` on every `on_tool_start` event (since preceding text was intermediate planning). Return a `{ fullText, finalResponse }` object where `finalResponse` is the text from only the last LLM turn (after all tool calls complete). Falls back to `fullText` if the last segment is empty.
- 2. **`connectors/manager.ts`** — `routeMessage` now uses `result.finalResponse` instead of the full concatenated text. Only the agent's actual answer gets delivered to WhatsApp/Discord/Telegram/Slack.
- 3. **`chat-execution.ts`** — Web UI caller uses `.fullText` to preserve existing behavior (SSE already streams everything live, and the full text is saved for session history replay).

## Commands Run
- **Root cause**: In `stream-agent-chat.ts`, the LangGraph ReAct agent loop fires `on_chat_model_stream` for every LLM turn — including intermediate turns where the agent outputs planning text ("Let me check...", "Checking git log:") before making tool calls. All of this text was concatenated into `fullText` and returned as a single string. When `routeMessage` in `manager.ts` sent this to WhatsApp, the user received the entire internal reasoning chain as one giant message.

## Verification
- Not provided
