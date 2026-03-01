import { NextResponse } from 'next/server'
export const dynamic = 'force-dynamic'


export async function GET(_req: Request) {
  return NextResponse.json({
    nodes: [
      { id: 'agent', description: 'LLM reasoning node — calls the model with tools bound' },
      { id: 'tools', description: 'Tool execution node — runs tool calls from the agent' },
      { id: 'router', description: 'Routing node — inspects tool results, handles fallback on delegate failures' },
    ],
    edges: [
      { from: '__start__', to: 'agent', type: 'direct' },
      { from: 'agent', to: 'tools', type: 'conditional', condition: 'has_tool_calls' },
      { from: 'agent', to: '__end__', type: 'conditional', condition: 'no_tool_calls' },
      { from: 'tools', to: 'router', type: 'direct' },
      { from: 'router', to: 'agent', type: 'conditional', condition: 'fallback_or_continue' },
    ],
    features: {
      checkpointing: true,
      interruptBefore: 'tools (when capability policy is strict)',
      fallbackRouting: 'Max 2 attempts when delegate_to_agent fails',
    },
  })
}
