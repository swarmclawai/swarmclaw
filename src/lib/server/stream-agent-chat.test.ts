import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import type { MessageToolEvent } from '@/types'
import {
  buildExternalWalletExecutionBlock,
  buildToolDisciplineLines,
  getExplicitRequiredToolNames,
  isNarrowDirectMemoryWriteTurn,
  isWalletSimulationResult,
  looksLikeOpenEndedDeliverableTask,
  resolveContinuationAssistantText,
  resolveFinalStreamResponseText,
  shouldAllowToolForDirectMemoryWrite,
  shouldAllowToolForCurrentThreadRecall,
  shouldTerminateOnSuccessfulMemoryMutation,
  shouldForceDeliverableFollowthrough,
  shouldForceExternalExecutionFollowthrough,
  shouldForceExternalServiceSummary,
} from './stream-agent-chat'

const streamAgentChatSource = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'stream-agent-chat'), 'utf-8')

describe('buildToolDisciplineLines', () => {
  it('tells the agent to use direct platform tools when manage_platform is absent', () => {
    const lines = buildToolDisciplineLines(['files', 'manage_schedules'])

    assert.equal(lines[0], 'Enabled tools in this session: `files`, `manage_schedules`.')
    assert.ok(lines.some((line) => line.includes('Do not substitute `manage_platform`')))
  })

  it('omits the manage_platform warning when the umbrella tool is enabled', () => {
    const lines = buildToolDisciplineLines(['manage_platform', 'manage_schedules'])

    assert.ok(lines.every((line) => !line.includes('Do not substitute `manage_platform`')))
  })

  it('includes concrete files-tool examples for revision work', () => {
    const lines = buildToolDisciplineLines(['files'])

    assert.ok(lines.some((line) => line.includes('{"action":"read","filePath":"path/to/file.md"}')))
    assert.ok(lines.some((line) => line.includes('exactly N bullet points')))
    assert.ok(lines.some((line) => line.includes('Lower-priority logistics belong in FYI')))
  })

  it('adds schedule reuse and stop guidance when schedule tools are enabled', () => {
    const lines = buildToolDisciplineLines(['manage_schedules', 'schedule_wake'])

    assert.ok(lines.some((line) => line.includes('reuse or update matching agent-created schedules')))
    assert.ok(lines.some((line) => line.includes('pause or delete every matching schedule you created in this chat')))
    assert.ok(lines.some((line) => line.includes('prefer `schedule_wake` over creating a recurring schedule')))
  })

  it('warns browser tasks to use literal urls and the supported form schema', () => {
    const lines = buildToolDisciplineLines(['web_search', 'web_fetch', 'browser', 'manage_connectors', 'http_request', 'email', 'ask_human', 'manage_secrets'])

    assert.ok(lines.some((line) => line.includes('Do not invent placeholder URLs')))
    assert.ok(lines.some((line) => line.includes('A shorthand `form` object keyed by input id/name also works')))
    assert.ok(lines.some((line) => line.includes('prefer `fill_form` and `submit_form`')))
    assert.ok(lines.some((line) => line.includes('For current events, breaking news, or "latest" requests, start with `web_search`')))
    assert.ok(lines.some((line) => line.includes('Use `browser` when the user asks for screenshots')))
    assert.ok(lines.some((line) => line.includes('do not capture screenshots') && line.includes('`browser`')))
    assert.ok(lines.some((line) => line.includes('connector_message_tool') && line.includes('list_running')))
    assert.ok(lines.some((line) => line.includes('connector/channel setup is missing')))
    assert.ok(lines.some((line) => line.includes('capture the artifact first with `browser`') && line.includes('`connector_message_tool`')))
    assert.ok(lines.some((line) => line.includes('Keep JSON request bodies as raw JSON strings')))
    assert.ok(lines.some((line) => line.includes('{"action":"send","to":"user@example.com","subject":"...","body":"..."}')))
    assert.ok(lines.some((line) => line.includes('do not guess or keep re-submitting blank forms')))
    assert.ok(lines.some((line) => line.includes('store it with `manage_secrets`') && line.includes('do not echo the raw value')))
    assert.ok(lines.some((line) => line.includes('Use `manage_secrets` only for sensitive credentials or tokens')))
  })

  it('adds bounded execution guidance for wallet-connected external-service tasks', () => {
    const lines = buildToolDisciplineLines(['wallet', 'browser', 'http_request', 'manage_capabilities'])

    assert.ok(lines.some((line) => line.includes('inspect the available wallet first with `wallet_tool`')))
    assert.ok(lines.some((line) => line.includes('use a bounded loop') && line.includes('Do not keep browsing once the blocker is clear')))
    assert.ok(lines.some((line) => line.includes('do not shop across venues indefinitely')))
    assert.ok(lines.some((line) => line.includes('If a direct tool for the job is already enabled in this session, call that tool immediately')))
  })

  it('tells agents to stay local when coding tools are already available', () => {
    const lines = buildToolDisciplineLines(['files', 'shell', 'delegate'])

    assert.ok(lines.some((line) => line.includes('prefer using them directly for straightforward coding and verification')))
  })

  it('adds explicit human-loop mailbox sequencing guidance when ask_human is enabled', () => {
    const lines = buildToolDisciplineLines(['browser', 'ask_human'])

    assert.ok(lines.some((line) => line.includes('request_input') && line.includes('wait_for_reply') && line.includes('list_mailbox')))
    assert.ok(lines.some((line) => line.includes('omit `envelopeId` to ack the newest unread human reply')))
    assert.ok(lines.some((line) => line.includes('Do not loop on `status` without a `watchJobId` or `approvalId`')))
  })

  it('does not force capability-inferred tools — trusts the LLM to select tools (OpenClaw approach)', () => {
    // Previously, regex-based capability matching forced web_search, browser, connector_message_tool
    // based on keywords in the user message. This caused false positives and extra continuation loops.
    // Now we trust the LLM to select the right tools from the prompt, like OpenClaw does.
    const required = getExplicitRequiredToolNames(
      'Can you tell me more if there is any news related to the US-Iran war, and can you send me some screenshots and give me a summary and maybe send me a voice note about it?',
      ['web_search', 'web_fetch', 'browser', 'manage_connectors'],
    )
    assert.deepEqual(required, [])
  })

  it('does not force connector delivery based on "send" keyword — avoids false positives', () => {
    const required = getExplicitRequiredToolNames(
      'Write a Python script that sends an HTTP GET request to httpbin.org/get and save the response.',
      ['web_search', 'manage_connectors', 'files'],
    )
    assert.deepEqual(required, [])
  })

  it('does not force wallet tools based on keyword matching', () => {
    const required = getExplicitRequiredToolNames(
      'Use the available wallets and figure out how to trade on Hyperliquid.',
      ['wallet', 'browser', 'http_request'],
    )
    assert.deepEqual(required, [])
  })

  it('tells the agent that named enabled tools are completion requirements', () => {
    assert.ok(streamAgentChatSource.includes('If a task explicitly names an enabled tool, use that tool before declaring success.'))
    assert.ok(streamAgentChatSource.includes('collect required human input through the tool'))
    assert.ok(streamAgentChatSource.includes('You have not yet completed the required explicit tool step(s):'))
    assert.ok(streamAgentChatSource.includes('do not replace screenshot requests with text-only summaries'))
    assert.ok(streamAgentChatSource.includes('## External Service Execution'))
    assert.ok(streamAgentChatSource.includes('toolCallId: event.run_id'))
    assert.ok(streamAgentChatSource.includes('[Loop Budget Reached]'))
    assert.ok(streamAgentChatSource.includes('ToolLoopTracker'))
    assert.ok(!streamAgentChatSource.includes('langchainMessages.push(new AIMessage({ content: fullText }))'))
  })

  it('adds a dedicated current-thread recall block and removes long-term memory tools for those turns', () => {
    assert.ok(streamAgentChatSource.includes('## Current Thread Recall'))
    assert.ok(streamAgentChatSource.includes('## Immediate Memory Routes'))
    assert.ok(streamAgentChatSource.includes('## Direct Memory Write'))
    assert.ok(streamAgentChatSource.includes('call `memory_store` or `memory_update` immediately before any planning, delegation, task creation, or agent management'))
    assert.ok(streamAgentChatSource.includes('Do not inspect skills, browse the workspace, request capabilities, manage tasks, manage agents, or delegate before the direct memory write is complete.'))
    assert.ok(streamAgentChatSource.includes('Do NOT call memory tools, web search, or session-history tools'))
    assert.ok(streamAgentChatSource.includes('const currentThreadRecallRequest = !directMemoryWriteOnlyTurn && isCurrentThreadRecallRequest(message)'))
    assert.ok(streamAgentChatSource.includes('const directMemoryWriteOnlyTurn = isNarrowDirectMemoryWriteTurn(message)'))
    assert.ok(streamAgentChatSource.includes('shouldAllowToolForDirectMemoryWrite(toolName)'))
    assert.ok(streamAgentChatSource.includes('shouldAllowToolForCurrentThreadRecall(toolName)'))
    assert.ok(streamAgentChatSource.includes('Preserve hard structural constraints from the original request'))
    assert.ok(streamAgentChatSource.includes('## Exact Structural Constraints'))
  })

  it('blocks memory, session-history, web, and context tools during same-thread recall turns', () => {
    assert.equal(shouldAllowToolForCurrentThreadRecall('memory_tool'), false)
    assert.equal(shouldAllowToolForCurrentThreadRecall('memory_search'), false)
    assert.equal(shouldAllowToolForCurrentThreadRecall('memory_get'), false)
    assert.equal(shouldAllowToolForCurrentThreadRecall('memory_store'), false)
    assert.equal(shouldAllowToolForCurrentThreadRecall('memory_update'), false)
    assert.equal(shouldAllowToolForCurrentThreadRecall('search_history_tool'), false)
    assert.equal(shouldAllowToolForCurrentThreadRecall('sessions_tool'), false)
    assert.equal(shouldAllowToolForCurrentThreadRecall('web_search'), false)
    assert.equal(shouldAllowToolForCurrentThreadRecall('context_status'), false)
    assert.equal(shouldAllowToolForCurrentThreadRecall('files'), true)
  })

  it('only allows direct memory write tools during pure remember/store turns', () => {
    assert.equal(shouldAllowToolForDirectMemoryWrite('memory_store'), true)
    assert.equal(shouldAllowToolForDirectMemoryWrite('memory_update'), true)
    assert.equal(shouldAllowToolForDirectMemoryWrite('memory_tool'), false)
    assert.equal(shouldAllowToolForDirectMemoryWrite('manage_capabilities'), false)
    assert.equal(shouldAllowToolForDirectMemoryWrite('files'), false)
  })

  it('treats long remember-and-confirm turns as narrow direct memory writes', () => {
    assert.equal(
      isNarrowDirectMemoryWriteTurn('Remember that my favorite programming language is Rust and I prefer functional programming patterns. Then confirm what you just stored.'),
      true,
    )
    assert.equal(
      isNarrowDirectMemoryWriteTurn('Remember these facts for future conversations: My favorite programming language is Rust. My deploy target is Fly.io. My team size is 7 people. The project is codenamed "Neptune".'),
      true,
    )
    assert.equal(
      isNarrowDirectMemoryWriteTurn('Remember that my favorite programming language is Rust, then write a file summarizing it and send it to me.'),
      false,
    )
  })

  it('canonicalizes required tool names when checking completion', () => {
    // The requiredToolsPending filter must canonicalize tool names so that
    // alias names (e.g. ask_human) match canonical names from LangGraph events.
    assert.ok(streamAgentChatSource.includes('canonicalizePluginId(toolName) || toolName'))
    assert.ok(streamAgentChatSource.includes('!usedToolNames.has(toolName) && !usedToolNames.has(canonical)'))
  })

  it('treats shell-based HTTP commands (curl/gh) as satisfying web research requirements', () => {
    // When shell runs curl/wget/gh, the web tool should be marked as used.
    assert.ok(streamAgentChatSource.includes("curl|wget|http|gh\\s+(issue|pr|api|repo|release|search|run)"))
    assert.ok(streamAgentChatSource.includes("if (cmdMatch) usedToolNames.add('web')"))
  })
})

describe('buildExternalWalletExecutionBlock', () => {
  it('omits plugin-specific tool names when wallet/network capabilities are unavailable', () => {
    const block = buildExternalWalletExecutionBlock(['files'])

    assert.equal(block, '')
  })

  it('uses only enabled wallet-related tools in the external execution block', () => {
    const block = buildExternalWalletExecutionBlock(['wallet', 'http_request', 'manage_capabilities'])

    assert.ok(block.includes('## External Service Execution'))
    assert.ok(!block.includes('`browser`'))
    assert.ok(!block.includes('`wallet_tool`'))
    assert.ok(!block.includes('`manage_capabilities`'))
    assert.ok(block.includes('Define a stop condition before exploring'))
  })
})

describe('isWalletSimulationResult', () => {
  it('detects simulated wallet transaction outputs and ignores other tool outputs', () => {
    assert.equal(
      isWalletSimulationResult('wallet_tool', '{"status":"simulated","action":"simulate_transaction"}'),
      true,
    )
    assert.equal(
      isWalletSimulationResult('wallet_tool', '{"status":"broadcast","action":"send_transaction"}'),
      false,
    )
    assert.equal(
      isWalletSimulationResult('http_request', '{"status":"simulated"}'),
      false,
    )
  })
})

describe('looksLikeOpenEndedDeliverableTask', () => {
  it('detects open-ended deliverable prompts', () => {
    assert.equal(
      looksLikeOpenEndedDeliverableTask('Revise the landing copy and update the proposal draft with a stronger second pass.'),
      true,
    )
  })

  it('does not misclassify explicit coding tasks', () => {
    assert.equal(
      looksLikeOpenEndedDeliverableTask('Fix the React bug in src/components/chat/chat-area.tsx and run npm run build.'),
      false,
    )
  })

  it('detects multi-artifact research-and-build prompts', () => {
    assert.equal(
      looksLikeOpenEndedDeliverableTask('Can you go to wikipedia, research 3 topics, take screenshots, create MD and PDF files, then build a site for each topic and start the dev servers?'),
      true,
    )
  })
})

describe('resolveFinalStreamResponseText', () => {
  it('uses the latest settled text segment when a tool run ends after another tool call', () => {
    const result = resolveFinalStreamResponseText({
      fullText: 'I will start the work.\n\nI found the issue and fixed it.',
      lastSegment: '',
      lastSettledSegment: 'I found the issue and fixed it.',
      hasToolCalls: true,
    })

    assert.equal(result, 'I found the issue and fixed it.')
  })

  it('falls back to the full text when there were no tool calls', () => {
    const result = resolveFinalStreamResponseText({
      fullText: 'Simple direct answer.',
      lastSegment: 'Simple direct answer.',
      lastSettledSegment: '',
      hasToolCalls: false,
    })

    assert.equal(result, 'Simple direct answer.')
  })

  it('falls back to the latest meaningful tool result when tool calls finished without prose', () => {
    const result = resolveFinalStreamResponseText({
      fullText: '',
      lastSegment: '',
      lastSettledSegment: '',
      hasToolCalls: true,
      toolEvents: [
        { name: 'memory_tool', input: '', output: 'Stored memory "Project Kodiak details" (id: abc123).' } as MessageToolEvent,
      ],
    })

    assert.equal(result, 'Stored memory "Project Kodiak details" (id: abc123).')
  })
})

describe('resolveContinuationAssistantText', () => {
  it('prefers the current iteration text instead of any cumulative transcript', () => {
    const result = resolveContinuationAssistantText({
      iterationText: 'Second pass only.\n\nRevised final section.',
      lastSegment: 'Revised final section.',
    })

    assert.equal(result, 'Second pass only.\n\nRevised final section.')
  })

  it('falls back to the last segment when iteration text is empty', () => {
    const result = resolveContinuationAssistantText({
      iterationText: '',
      lastSegment: 'Final concise summary.',
    })

    assert.equal(result, 'Final concise summary.')
  })

  it('rolls back partial iteration text before transient retries restart the turn', () => {
    assert.ok(streamAgentChatSource.includes('const iterationStartState:'))
    assert.ok(streamAgentChatSource.includes('fullText = iterationStartState.fullText'))
    assert.ok(streamAgentChatSource.includes('lastSegment = iterationStartState.lastSegment'))
    assert.ok(streamAgentChatSource.includes('lastSettledSegment = iterationStartState.lastSettledSegment'))
    assert.ok(streamAgentChatSource.includes('needsTextSeparator = iterationStartState.needsTextSeparator'))
  })
})

describe('shouldTerminateOnSuccessfulMemoryMutation', () => {
  it('treats successful memory_tool store results as terminal', () => {
    assert.equal(
      shouldTerminateOnSuccessfulMemoryMutation({
        toolName: 'memory_tool',
        toolInput: { action: 'store', title: 'Project Kodiak details' },
        toolOutput: 'Stored memory "Project Kodiak details" (id: abc123). No further memory lookup is needed unless the user asked you to verify.',
      }),
      true,
    )
  })

  it('treats successful narrow memory write tools as terminal', () => {
    assert.equal(
      shouldTerminateOnSuccessfulMemoryMutation({
        toolName: 'memory_store',
        toolInput: { title: 'Project Kodiak details', value: 'freeze date April 18, 2026' },
        toolOutput: 'Stored memory "Project Kodiak details" (id: abc123). No further memory lookup is needed unless the user asked you to verify.',
      }),
      true,
    )
    assert.equal(
      shouldTerminateOnSuccessfulMemoryMutation({
        toolName: 'memory_update',
        toolInput: { id: 'abc123', value: 'freeze date April 21, 2026' },
        toolOutput: 'Updated memory "Project Kodiak details" (id: abc123). No further memory lookup is needed unless the user asked you to verify.',
      }),
      true,
    )
  })

  it('parses JSON tool input and accepts canonical update results', () => {
    assert.equal(
      shouldTerminateOnSuccessfulMemoryMutation({
        toolName: 'memory_tool',
        toolInput: '{"action":"update","title":"Project Kodiak details"}',
        toolOutput: 'Updated memory "Project Kodiak details" (id: abc123). No further memory lookup is needed unless the user asked you to verify.',
      }),
      true,
    )
  })

  it('does not terminate on memory search/list calls or error outputs', () => {
    assert.equal(
      shouldTerminateOnSuccessfulMemoryMutation({
        toolName: 'memory_tool',
        toolInput: { action: 'search', query: 'Project Kodiak' },
        toolOutput: 'Found 2 memories.',
      }),
      false,
    )
    assert.equal(
      shouldTerminateOnSuccessfulMemoryMutation({
        toolName: 'memory_tool',
        toolInput: { action: 'update', id: 'missing' },
        toolOutput: 'Memory not found or access denied.',
      }),
      false,
    )
  })
})

describe('shouldForceExternalServiceSummary', () => {
  it('forces a summary when an external-service run ends with an unfinished exploration sentence', () => {
    assert.equal(
      shouldForceExternalServiceSummary({
        userMessage: 'Try to trade on Hyperliquid with the available wallet and stop at the blocker.',
        finalResponse: 'This is promising - Hyperliquid runs on Arbitrum! Let me verify this and check if I can access their interface:',
        hasToolCalls: true,
        toolEventCount: 6,
      }),
      true,
    )
  })

  it('does not force a summary when the final response already states the blocker', () => {
    assert.equal(
      shouldForceExternalServiceSummary({
        userMessage: 'Try to trade on Hyperliquid with the available wallet and stop at the blocker.',
        finalResponse: 'Last reversible step: I verified the funded Arbitrum wallet and opened the site. Exact blocker: this runtime cannot complete a WalletConnect signature prompt.',
        hasToolCalls: true,
        toolEventCount: 6,
      }),
      false,
    )
  })
})

describe('shouldForceExternalExecutionFollowthrough', () => {
  const researchToolEvents = [
    { name: 'wallet_tool', input: '{"action":"balance","chain":"ethereum"}', output: '{"status":"ok"}' },
    { name: 'http_request', input: '{"method":"GET","url":"https://example.com/quote"}', output: '{"status":200}' },
    { name: 'web', input: '{"action":"open","url":"https://example.com/swap"}', output: '{"status":"ok"}' },
    { name: 'browser', input: '{"action":"read_page"}', output: '{"title":"Swap"}' },
  ]

  it('forces a followthrough when a bounded execution task stalls in research mode', () => {
    assert.equal(
      shouldForceExternalExecutionFollowthrough({
        userMessage: 'Do one tiny live swap on Arbitrum and stop at the first approval boundary.',
        finalResponse: 'Promising. I found a no-key route source and now I will compare one more option before proceeding.',
        hasToolCalls: true,
        toolEvents: researchToolEvents,
      }),
      true,
    )
  })

  it('forces a followthrough when the run ends after research with no final text', () => {
    assert.equal(
      shouldForceExternalExecutionFollowthrough({
        userMessage: 'Do one tiny live swap on Arbitrum and stop at the first approval boundary.',
        finalResponse: '',
        hasToolCalls: true,
        toolEvents: researchToolEvents,
      }),
      true,
    )
  })

  it('forces a followthrough after repeated venue-shopping across distinct hosts', () => {
    assert.equal(
      shouldForceExternalExecutionFollowthrough({
        userMessage: 'Do one tiny live swap on Arbitrum and stop at the first approval boundary.',
        finalResponse: 'Let me try another aggregator before proceeding.',
        hasToolCalls: true,
        toolEvents: [
          { name: 'wallet_tool', input: '{"action":"balance","chain":"ethereum"}', output: '{"status":"ok"}' },
          { name: 'http_request', input: '{"method":"GET","url":"https://api.0x.org/swap/v1/quote"}', output: '{"status":404}' },
          { name: 'http_request', input: '{"method":"GET","url":"https://apiv5.paraswap.io/prices"}', output: '{"status":400}' },
          { name: 'http_request', input: '{"method":"POST","url":"https://api.odos.xyz/sor/quote/v2"}', output: '{"status":200}' },
        ],
      }),
      true,
    )
  })

  it('does not force a followthrough after a wallet approval boundary is reached', () => {
    assert.equal(
      shouldForceExternalExecutionFollowthrough({
        userMessage: 'Do one tiny live swap on Arbitrum and stop at the first approval boundary.',
        finalResponse: 'Current status: approval required for the exact-input token approval.',
        hasToolCalls: true,
        toolEvents: [
          ...researchToolEvents,
          {
            name: 'wallet_tool',
            input: '{"action":"send_transaction","chain":"ethereum"}',
            output: '{"type":"plugin_wallet_action_request","status":"pending"}',
          },
        ],
      }),
      false,
    )
  })
})

describe('shouldForceDeliverableFollowthrough', () => {
  const deliverableToolEvents = [
    { name: 'browser', input: '{"action":"navigate","url":"https://en.wikipedia.org/wiki/Artificial_intelligence"}', output: '{"status":"ok"}' },
    { name: 'browser', input: '{"action":"screenshot"}', output: '{"path":"/tmp/ai.png"}' },
    { name: 'files', input: '{"action":"write","filePath":"ai.md"}', output: '{"ok":true}' },
    { name: 'shell', input: '{"command":"which pandoc"}', output: '/usr/local/bin/pandoc' },
  ]

  it('forces a followthrough when a multi-artifact run stops after a partial batch', () => {
    assert.equal(
      shouldForceDeliverableFollowthrough({
        userMessage: 'Can you go to wikipedia, research 3 topics, take screenshots of those topics, create a MD and PDF file of each, then create a site on each topic and start the dev servers?',
        finalResponse: "Screenshots captured for all three topics. Now I'll create markdown and PDF files for each topic, then build sites:",
        hasToolCalls: true,
        toolEvents: deliverableToolEvents,
      }),
      true,
    )
  })

  it('does not force a followthrough after a concrete delivered summary', () => {
    assert.equal(
      shouldForceDeliverableFollowthrough({
        userMessage: 'Research 3 topics, create screenshots, PDFs, and sites.',
        finalResponse: 'Task complete. Shared `/tmp/ai.md`, `/tmp/ai.pdf`, `/tmp/ai-site/index.html`, and screenshot `/api/uploads/ai-site.png`. Running site: http://127.0.0.1:4310',
        hasToolCalls: true,
        toolEvents: deliverableToolEvents,
      }),
      false,
    )
  })

  it('forces followthrough when user asks to save HTML file but no file tool was used', () => {
    assert.equal(
      shouldForceDeliverableFollowthrough({
        userMessage: 'Create a weather dashboard HTML page. Save it to /tmp/weather-dashboard.html',
        finalResponse: "Now I'll create a clean, styled weather dashboard HTML page with the current weather data.",
        hasToolCalls: true,
        toolEvents: [
          { name: 'web', input: '{"action":"search","query":"weather London"}', output: 'results...' },
          { name: 'web', input: '{"action":"fetch","url":"https://wttr.in/London?format=j1"}', output: '{"temp":"10C"}' },
        ],
      }),
      true,
    )
  })

  it('does not force followthrough when file tool was already used', () => {
    assert.equal(
      shouldForceDeliverableFollowthrough({
        userMessage: 'Create a weather dashboard HTML page. Save it to /tmp/weather-dashboard.html',
        finalResponse: 'Done! The dashboard has been saved to /tmp/weather-dashboard.html',
        hasToolCalls: true,
        toolEvents: [
          { name: 'web', input: '{"action":"fetch","url":"https://wttr.in/London?format=j1"}', output: '{"temp":"10C"}' },
          { name: 'files', input: '{"action":"write","filePath":"/tmp/weather-dashboard.html"}', output: '{"ok":true}' },
        ],
      }),
      false,
    )
  })
})

describe('looksLikeOpenEndedDeliverableTask — file-output regression', () => {
  it('detects HTML dashboard creation task', () => {
    assert.equal(
      looksLikeOpenEndedDeliverableTask('Create a weather dashboard HTML page and save it to /tmp/dashboard.html'),
      true,
    )
  })

  it('detects save-to-file with explicit path', () => {
    assert.equal(
      looksLikeOpenEndedDeliverableTask('Build a simple landing page. Save it to ~/projects/landing.html'),
      true,
    )
  })

  it('detects .html file extension in broad goal', () => {
    assert.equal(
      looksLikeOpenEndedDeliverableTask('Generate a weather report dashboard and export to report.html'),
      true,
    )
  })

  it('still excludes explicit coding tasks', () => {
    assert.equal(
      looksLikeOpenEndedDeliverableTask('Fix the bug in src/components/dashboard.tsx and run npm run build'),
      false,
    )
  })
})
