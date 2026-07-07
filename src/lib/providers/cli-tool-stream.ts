/**
 * Shared parser for Anthropic-style stream-json output emitted by Claude Code
 * CLI and compatible CLIs (Qwen Code, Cursor Agent). These CLIs run tools
 * inside their own subprocess; this surfaces those tool calls as SwarmClaw
 * tool_call/tool_result SSE events so they are visible in the chat, with the
 * agent's inter-step narration attached as the tool's `reasoning`.
 *
 * It is a no-op for events that do not use this shape, so it is safe to call
 * from any CLI provider's stream loop.
 */

export interface CliToolStreamCtx {
  /** Maps tool_use ids to their tool name so tool_result events can be matched. */
  names: Map<string, string>
  /** Narration/thinking accumulated since the last tool call. */
  reasoning: string
}

export function createCliToolStreamCtx(): CliToolStreamCtx {
  return { names: new Map(), reasoning: '' }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function stringifyInput(input: unknown): string {
  if (typeof input === 'string') return input
  try { return JSON.stringify(input ?? {}) } catch { return '' }
}

function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const p = asRecord(part)
        return p && p.type === 'text' && typeof p.text === 'string' ? p.text : ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

export function emitCliStreamToolEvents(
  ev: unknown,
  ctx: CliToolStreamCtx,
  write: (chunk: string) => void,
): void {
  const event = asRecord(ev)
  if (!event) return
  const message = asRecord(event.message)
  const content = Array.isArray(message?.content) ? (message!.content as unknown[]) : null
  if (!content) return

  if (event.type === 'assistant') {
    for (const raw of content) {
      const block = asRecord(raw)
      if (!block) continue
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        // Narration before a tool is that tool's reasoning; final answer text
        // (not followed by a tool) is simply never attached.
        ctx.reasoning = block.text
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        ctx.reasoning += block.thinking
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        const id = typeof block.id === 'string' ? block.id : undefined
        if (id) ctx.names.set(id, block.name)
        const toolInput = stringifyInput(block.input)
        const reasoning = ctx.reasoning.trim()
        ctx.reasoning = ''
        write(`data: ${JSON.stringify({ t: 'tool_call', toolName: block.name, toolInput, toolCallId: id, reasoning: reasoning || undefined })}\n\n`)
      }
    }
  } else if (event.type === 'user') {
    for (const raw of content) {
      const block = asRecord(raw)
      if (!block || block.type !== 'tool_result') continue
      const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined
      const toolName = (id && ctx.names.get(id)) || 'unknown'
      let toolOutput = extractToolResultText(block.content)
      if (block.is_error && toolOutput && !/^error/i.test(toolOutput.trim())) {
        toolOutput = `Error: ${toolOutput}`
      }
      write(`data: ${JSON.stringify({ t: 'tool_result', toolName, toolOutput, toolCallId: id })}\n\n`)
    }
  }
}
