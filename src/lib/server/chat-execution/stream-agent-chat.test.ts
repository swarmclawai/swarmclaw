import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import type { MessageToolEvent } from '@/types'
import {
  buildToolAvailabilityLines,
  buildExternalWalletExecutionBlock,
  buildToolDisciplineLines,
  getExplicitRequiredToolNames,
  isWalletSimulationResult,
  looksLikeOpenEndedDeliverableTask,
  resolveContinuationAssistantText,
  resolveFinalStreamResponseText,
  shouldForceAttachmentFollowthrough,
  shouldForceRecoverableToolErrorFollowthrough,
  shouldTerminateOnSuccessfulMemoryMutation,
  shouldForceDeliverableFollowthrough,
  shouldForceExternalExecutionFollowthrough,
  shouldForceExternalServiceSummary,
} from '@/lib/server/chat-execution/stream-agent-chat'
import { hasIncompleteDelegationWait } from '@/lib/server/chat-execution/stream-continuation'

const streamAgentChatSource = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'stream-agent-chat.ts'), 'utf-8')
const streamContinuationSource = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'stream-continuation.ts'), 'utf-8')
const streamSources = `${streamAgentChatSource}\n${streamContinuationSource}`

describe('buildToolDisciplineLines', () => {
  it('lists exact callable tool names for plugin families like sandbox and browser', () => {
    const lines = buildToolAvailabilityLines(['sandbox', 'browser', 'manage_schedules'])

    assert.equal(lines[0], 'Tool names are case-sensitive. Call tools exactly as listed.')
    assert.ok(lines.includes('- `browser`'))
    assert.ok(lines.includes('- `manage_schedules`'))
    assert.ok(lines.includes('- `sandbox_exec`'))
    assert.ok(lines.includes('- `sandbox_list_runtimes`'))
  })

  it('tells the agent to use direct platform tools when manage_platform is absent', () => {
    const lines = buildToolDisciplineLines(['files', 'manage_schedules'])

    assert.equal(lines[0], 'Enabled tools in this session: `files`, `manage_schedules`, `send_file`.')
    assert.ok(lines.some((line) => line.includes('Do not substitute `manage_platform`')))
    assert.ok(lines.some((line) => line.includes('Treat enabled tools as available now')))
    assert.ok(lines.some((line) => line.includes('try that tool before telling the user to do it themselves')))
    assert.ok(lines.some((line) => line.includes('Only talk about approvals when a tool result explicitly returns an approval boundary')))
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
    assert.ok(lines.some((line) => line.includes('try one other enabled acquisition path') && line.includes('`http_request`') && line.includes('`browser`')))
    assert.ok(lines.some((line) => line.includes('browser or web timeout is not final')))
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
    assert.ok(lines.some((line) => line.includes('Do not loop on `status` without a `watchJobId`')))
  })

  it('tells agents to draft email content directly and to use real file writes for named artifacts', () => {
    const lines = buildToolDisciplineLines(['files', 'email', 'spawn_subagent'])

    assert.ok(lines.some((line) => line.includes('draft, outline, critique, or revise email copy')))
    assert.ok(lines.some((line) => line.includes('make your first concrete step an actual file-writing tool call')))
    assert.ok(lines.some((line) => line.includes('capture the returned `swarmId`')))
  })

  it('does not force capability-inferred tools — trusts the LLM to select tools', () => {
    // Previously, regex-based capability matching forced web_search, browser, connector_message_tool
    // based on keywords in the user message. This caused false positives and extra continuation loops.
    // Now we trust the LLM to select the right tools from the prompt.
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

  it('treats explicit curl or terminal execution requests as shell requirements when shell is enabled', () => {
    const required = getExplicitRequiredToolNames(
      'Yeah, do the curl. Curl request.',
      ['shell', 'web', 'browser'],
    )
    assert.deepEqual(required, ['shell'])
  })

  it('does not force shell just because a prompt mentions curl in a non-execution context', () => {
    const required = getExplicitRequiredToolNames(
      'Write a shell script that uses curl to fetch a page.',
      ['shell', 'files'],
    )
    assert.deepEqual(required, [])
  })

  it('treats explicit save-to-file requests as required file-tool steps', () => {
    const required = getExplicitRequiredToolNames(
      'Research the topic and save the report as wasm-report.md in the current directory.',
      ['files', 'web'],
    )
    assert.deepEqual(required, ['files'])
  })

  it('does not force outbound email delivery for drafting-only requests', () => {
    const required = getExplicitRequiredToolNames(
      'Draft a 3-email onboarding sequence for new SaaS customers.',
      ['email', 'files'],
    )
    assert.deepEqual(required, [])
  })

  it('tells the agent that named enabled tools are completion requirements', () => {
    assert.ok(streamAgentChatSource.includes('If a task explicitly names an enabled tool, use that tool before declaring success.'))
    assert.ok(streamAgentChatSource.includes('collect required human input through the tool'))
    assert.ok(streamAgentChatSource.includes('## Attachments'))
    assert.ok(streamAgentChatSource.includes('Do not claim you cannot use images, attachments, or external tools when those capabilities are available in this session.'))
    assert.ok(streamSources.includes('You have not yet completed the required explicit tool step(s):'))
    assert.ok(streamSources.includes('attachment_followthrough'))
    assert.ok(streamSources.includes('unfinished_tool_followthrough'))
    assert.ok(streamSources.includes('tool_error_followthrough'))
    assert.ok(streamSources.includes('The previous iteration ended before all tool calls finished returning results.'))
    assert.ok(streamSources.includes('Do not stop after the first failed acquisition attempt.'))
    assert.ok(streamSources.includes('do not replace screenshot requests with text-only summaries'))
    assert.ok(streamAgentChatSource.includes('## External Service Execution'))
    assert.ok(streamAgentChatSource.includes('toolCallId: event.run_id'))
    assert.ok(streamAgentChatSource.includes('[Loop Budget Reached]'))
    assert.ok(streamAgentChatSource.includes('ToolLoopTracker'))
    assert.ok(!streamAgentChatSource.includes('langchainMessages.push(new AIMessage({ content: fullText }))'))
  })

  it('forces early workspace-tool kickoff for explicit saved-artifact deliverables', () => {
    assert.ok(streamAgentChatSource.includes('shouldEnforceEarlyRequiredToolKickoff'))
    assert.ok(streamAgentChatSource.includes('REQUIRED_TOOL_KICKOFF_TIMEOUT_MS'))
    assert.ok(streamAgentChatSource.includes('tool_kickoff_timeout'))
    assert.ok(streamAgentChatSource.includes('did not start the required workspace tool step'))
  })

  it('adds current-thread recall guidance and immediate memory routes in the system prompt', () => {
    assert.ok(streamAgentChatSource.includes('## Current Thread Recall'))
    assert.ok(streamAgentChatSource.includes('## Immediate Memory Routes'))
    assert.ok(streamAgentChatSource.includes('call `memory_store` or `memory_update` immediately before any planning, delegation, task creation, or agent management'))
    assert.ok(streamAgentChatSource.includes('Do NOT call memory tools, web search, or session-history tools'))
    assert.ok(streamAgentChatSource.includes('const currentThreadRecallRequest = isCurrentThreadRecallRequest(message)'))
    assert.ok(streamSources.includes('Preserve hard structural constraints from the original request'))
    assert.ok(streamAgentChatSource.includes('## Exact Structural Constraints'))
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

  it('surfaces a useful fallback from spawn_subagent JSON output', () => {
    const result = resolveFinalStreamResponseText({
      fullText: '',
      lastSegment: '',
      lastSettledSegment: '',
      hasToolCalls: true,
      toolEvents: [
        {
          name: 'spawn_subagent',
          input: '{"action":"swarm","waitForCompletion":false,"background":true}',
          output: '{"action":"swarm","status":"running","swarmId":"sw-123","memberCount":3}',
        } as MessageToolEvent,
      ],
    })

    assert.equal(result, 'Swarm sw-123 is running with 3 members.')
  })
})

describe('shouldForceRecoverableToolErrorFollowthrough', () => {
  it('continues after a browser timeout when the response is only a short failure note', () => {
    assert.equal(
      shouldForceRecoverableToolErrorFollowthrough({
        userMessage: 'Open the site, inspect it, and tell me what changed.',
        finalResponse: 'The operation was aborted due to timeout.',
        hasToolCalls: true,
        toolEvents: [
          {
            name: 'browser',
            input: '{"action":"navigate","url":"https://example.com"}',
            output: 'Error: The operation was aborted due to timeout',
            error: true,
          },
        ],
      }),
      true,
    )
  })

  it('does not force another continuation when the response already names a real human blocker', () => {
    assert.equal(
      shouldForceRecoverableToolErrorFollowthrough({
        userMessage: 'Open the account page and finish the flow.',
        finalResponse: 'The site now requires a verification code from the user, so I need human input before continuing.',
        hasToolCalls: true,
        toolEvents: [
          {
            name: 'browser',
            input: '{"action":"navigate","url":"https://example.com/account"}',
            output: 'Error: timeout waiting for page load',
            error: true,
          },
        ],
      }),
      false,
    )
  })
})

describe('hasIncompleteDelegationWait', () => {
  it('flags incomplete waited swarm output so the runtime can continue instead of summarizing early', () => {
    assert.equal(hasIncompleteDelegationWait([
      {
        name: 'spawn_subagent',
        input: '{"action":"swarm","waitForCompletion":true}',
        output: '{"action":"swarm","status":"partial","totalSpawned":3,"totalCompleted":1,"totalFailed":0,"totalCancelled":0,"totalSpawnErrors":0}',
      } as MessageToolEvent,
    ]), true)
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

describe('shouldForceAttachmentFollowthrough', () => {
  it('forces a retry for attachment-backed research turns that still skipped tools', () => {
    assert.equal(
      shouldForceAttachmentFollowthrough({
        userMessage: 'Look up my ally code from the attached screenshot.',
        enabledPlugins: ['web', 'browser'],
        hasToolCalls: false,
        hasAttachmentContext: true,
      }),
      true,
    )
    assert.equal(
      shouldForceAttachmentFollowthrough({
        userMessage: 'Research the URL shown in the attached screenshot and inspect it in the browser.',
        enabledPlugins: ['web', 'browser'],
        hasToolCalls: false,
        hasAttachmentContext: true,
      }),
      true,
    )
  })

  it('does not force a retry when there was no attachment context or a real tool attempt already happened', () => {
    assert.equal(
      shouldForceAttachmentFollowthrough({
        userMessage: 'Look up my ally code from the attached screenshot.',
        enabledPlugins: ['web', 'browser'],
        hasToolCalls: false,
        hasAttachmentContext: false,
      }),
      false,
    )
    assert.equal(
      shouldForceAttachmentFollowthrough({
        userMessage: 'Look up my ally code from the attached screenshot.',
        enabledPlugins: ['web', 'browser'],
        hasToolCalls: true,
        hasAttachmentContext: true,
      }),
      false,
    )
    assert.equal(
      shouldForceAttachmentFollowthrough({
        userMessage: 'What does this screenshot say?',
        enabledPlugins: ['web', 'browser'],
        hasToolCalls: false,
        hasAttachmentContext: true,
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

  it('forces followthrough when a requested artifact path is still missing on disk', () => {
    const cwd = fs.mkdtempSync('/tmp/swarmclaw-deliverable-missing-')
    try {
      assert.equal(
        shouldForceDeliverableFollowthrough({
          userMessage: 'Write the launch brief to `launch-brief.md` and the change log to `changes.txt`.',
          finalResponse: 'Done. Saved launch-brief.md and changes.txt.',
          hasToolCalls: true,
          cwd,
          toolEvents: [
            { name: 'files', input: '{"action":"write","filePath":"launch-brief.md"}', output: '{"ok":true}' },
          ],
        }),
        true,
      )
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('forces followthrough when an explicit file deliverable is still missing and no tools were used yet', () => {
    const cwd = fs.mkdtempSync('/tmp/swarmclaw-deliverable-no-tools-')
    try {
      assert.equal(
        shouldForceDeliverableFollowthrough({
          userMessage: 'Build a single-file HTML dashboard and save it as dashboard.html in the current directory.',
          finalResponse: 'I can create that dashboard for you.',
          hasToolCalls: false,
          cwd,
          toolEvents: [],
        }),
        true,
      )
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('does not force followthrough when requested artifact paths exist on disk', () => {
    const cwd = fs.mkdtempSync('/tmp/swarmclaw-deliverable-present-')
    try {
      fs.writeFileSync(path.join(cwd, 'launch-brief.md'), '# Brief\n')
      fs.writeFileSync(path.join(cwd, 'changes.txt'), '- change\n')
      assert.equal(
        shouldForceDeliverableFollowthrough({
          userMessage: 'Write the launch brief to `launch-brief.md` and the change log to `changes.txt`.',
          finalResponse: 'Done. Saved launch-brief.md and changes.txt.',
          hasToolCalls: true,
          cwd,
          toolEvents: [
            { name: 'files', input: '{"action":"write","filePath":"launch-brief.md"}', output: '{"ok":true}' },
            { name: 'files', input: '{"action":"write","filePath":"changes.txt"}', output: '{"ok":true}' },
          ],
        }),
        false,
      )
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
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

describe('transient provider retry coverage', () => {
  it('treats upstream 500 and 429 class failures as transient retry candidates', () => {
    assert.ok(streamAgentChatSource.includes('InternalServerError'))
    assert.ok(streamAgentChatSource.includes('RateLimitError'))
    assert.ok(streamAgentChatSource.includes('too many requests'))
    assert.ok(streamAgentChatSource.includes('internal server error'))
  })
})
