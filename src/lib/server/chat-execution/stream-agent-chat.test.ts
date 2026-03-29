import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import type { MessageToolEvent } from '@/types'
import { buildSuccessfulMemoryMutationResponse } from '@/lib/server/chat-execution/memory-mutation-tools'
import {
  buildToolAvailabilityLines,
  buildToolDisciplineLines,
  getExplicitRequiredToolNames,
  looksLikeOpenEndedDeliverableTask,
  pruneIncompleteToolEvents,
  resolveExclusiveMemoryWriteTerminalAllowance,
  resolveContinuationAssistantText,
  resolveFinalStreamResponseText,
  resolveSuccessfulTerminalToolBoundary,
  shouldSkipToolSummaryForShortResponse,
  shouldForceAttachmentFollowthrough,
  shouldForceExternalExecutionKickoffFollowthrough,
  shouldForceRecoverableToolErrorFollowthrough,
  shouldTerminateOnSuccessfulMemoryMutation,
  shouldForceDeliverableFollowthrough,
  shouldForceExternalExecutionFollowthrough,
  shouldForceExternalServiceSummary,
} from '@/lib/server/chat-execution/stream-agent-chat'
import {
  buildContinuationPrompt,
  hasIncompleteDelegationWait,
  shouldForceWorkspaceScopeShellFallback,
} from '@/lib/server/chat-execution/stream-continuation'
import type { DirectMemoryIntentClassifierInput } from '@/lib/server/chat-execution/direct-memory-intent'
import {
  parseClassificationResponse,
  isDeliverableTask,
  isBroadGoal,
  hasHumanSignals,
  hasSignificantEvent,
  isResearchSynthesis,
} from '@/lib/server/chat-execution/message-classifier'
import type { MessageClassification } from '@/lib/server/chat-execution/message-classifier'

const _dir = path.dirname(new URL(import.meta.url).pathname)
const _readSibling = (name: string) => fs.readFileSync(path.join(_dir, name), 'utf-8')
// The core streaming module was decomposed into several files — combine them
// so existing source-pattern assertions keep working.
const streamAgentChatSource = [
  _readSibling('stream-agent-chat.ts'),
  _readSibling('chat-turn-state.ts'),
  _readSibling('continuation-limits.ts'),
  _readSibling('prompt-builder.ts'),
  _readSibling('prompt-mode.ts'),
  _readSibling('prompt-budget.ts'),
  _readSibling('iteration-timers.ts'),
  _readSibling('iteration-event-handler.ts'),
  _readSibling('continuation-evaluator.ts'),
  _readSibling('post-stream-finalization.ts'),
  _readSibling('chat-streaming-utils.ts'),
  _readSibling('message-classifier.ts'),
].join('\n')
const streamContinuationSource = _readSibling('stream-continuation.ts')
const streamSources = `${streamAgentChatSource}\n${streamContinuationSource}`

describe('buildToolDisciplineLines', () => {
  it('lists exact callable tool names for legacy sandbox aliases and browser', () => {
    const lines = buildToolAvailabilityLines(['sandbox', 'browser', 'manage_schedules'])

    assert.equal(lines[0], 'Tool names are case-sensitive. Call tools exactly as listed.')
    assert.ok(lines.includes('- `browser`'))
    assert.ok(lines.includes('- `execute`'))
    assert.ok(lines.includes('- `manage_schedules`'))
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

  it('includes concrete files-tool examples for file work', () => {
    const lines = buildToolDisciplineLines(['files'])

    assert.ok(lines.some((line) => line.includes('{"action":"read","filePath":"path/to/file.md"}')))
    assert.ok(lines.some((line) => line.includes('{"action":"list","dirPath":"."}')))
    assert.ok(lines.some((line) => line.includes('{"action":"write","files":[{"path":"path/to/file.md","content":"..."}]}')))
  })

  it('tells the agent to use direct schedule tools when manage_platform is absent', () => {
    const lines = buildToolDisciplineLines(['manage_schedules', 'schedule_wake'])

    assert.ok(lines.some((line) => line.includes('Use direct platform tools exactly as named (`manage_schedules`)')))
    assert.ok(lines.some((line) => line.includes('Do not substitute `manage_platform` unless it is explicitly enabled.')))
  })

  it('warns browser-capable sessions to use current supported tool inputs and sequencing', () => {
    const lines = buildToolDisciplineLines(['web_search', 'web_fetch', 'browser', 'manage_connectors', 'http_request', 'email', 'ask_human', 'manage_secrets'])

    assert.ok(lines.some((line) => line.includes('Do not invent placeholder URLs')))
    assert.ok(lines.some((line) => line.includes('A shorthand `form` object keyed by input id/name also works')))
    assert.ok(lines.some((line) => line.includes('For current events, breaking news, or "latest" requests, start with `web_search`')))
    assert.ok(lines.some((line) => line.includes('Use `browser` when the user asks for screenshots')))
    assert.ok(lines.some((line) => line.includes('connector_message_tool') && line.includes('list_running')))
    assert.ok(lines.some((line) => line.includes('connector/channel setup is missing')))
    assert.ok(lines.some((line) => line.includes('Keep JSON request bodies as raw JSON strings')))
    assert.ok(lines.some((line) => line.includes('gather sources first, then capture')))
    assert.ok(lines.some((line) => line.includes('If one research path is blocked, try another') && line.includes('`http_request`') && line.includes('`browser`')))
    assert.ok(lines.some((line) => line.includes('{"action":"send","to":"user@example.com","subject":"...","body":"..."}')))
    assert.ok(lines.some((line) => line.includes('do not guess or keep re-submitting blank forms')))
    assert.ok(lines.some((line) => line.includes('Store secrets (passwords, API keys, tokens) with `manage_secrets`')))
  })

  it('includes concrete local coding tool guidance when coding tools are already available', () => {
    const lines = buildToolDisciplineLines(['files', 'shell', 'delegate'])

    assert.ok(lines.some((line) => line.includes('{"action":"read","filePath":"path/to/file.md"}')))
    assert.ok(lines.some((line) => line.includes('For `shell`, use `{"action":"execute","command":"..."}`')))
  })

  it('adds explicit ask_human request and wait guidance when ask_human is enabled', () => {
    const lines = buildToolDisciplineLines(['browser', 'ask_human'])

    assert.ok(lines.some((line) => line.includes('request_input') && line.includes('wait_for_reply') && line.includes('correlationId')))
    assert.ok(lines.some((line) => line.includes('do not guess or keep re-submitting blank forms')))
    assert.ok(lines.some((line) => line.includes('stop the turn immediately') && line.includes('durable wait returns active')))
    assert.ok(lines.some((line) => line.includes('same pending human question twice')))
  })

  it('tells agents how to send email and write files when those tools are enabled', () => {
    const lines = buildToolDisciplineLines(['files', 'email', 'spawn_subagent'])

    assert.ok(lines.some((line) => line.includes('For `email`, send mail with `{"action":"send","to":"user@example.com","subject":"...","body":"..."}`')))
    assert.ok(lines.some((line) => line.includes('If delivery depends on SMTP setup, check `{"action":"status"}` before claiming success.')))
    assert.ok(lines.some((line) => line.includes('{"action":"write","files":[{"path":"path/to/file.md","content":"..."}]}')))
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
    assert.ok(streamSources.includes('Do not claim that you cannot use images, attachments, or external tools when they are available in this session.'))
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

  it('wires prompt-build hooks and pre-tool loop guards into the runtime path', () => {
    assert.ok(streamAgentChatSource.includes('runCapabilityBeforePromptBuild'))
    assert.ok(streamAgentChatSource.includes('applyBeforePromptBuildResult'))
    assert.ok(streamAgentChatSource.includes('beforeToolCall: ({ toolName, input }) =>'))
    assert.ok(streamAgentChatSource.includes("phase: 'before_tool_call'"))
    assert.ok(streamAgentChatSource.includes('loopTracker.preview(toolName, input)'))
    assert.ok(streamAgentChatSource.includes('runId,'))
  })

  it('forces early workspace-tool kickoff for explicit saved-artifact deliverables', () => {
    assert.ok(streamAgentChatSource.includes('shouldEnforceEarlyRequiredToolKickoff'))
    assert.ok(streamAgentChatSource.includes('requiredToolKickoffMs'))
    assert.ok(streamAgentChatSource.includes('tool_kickoff_timeout'))
    assert.ok(streamAgentChatSource.includes('did not start the required workspace tool step'))
  })

  it('preflights explicitly unavailable tools before starting the streamed model run', () => {
    assert.ok(streamAgentChatSource.includes('resolveRequestedToolPreflightResponse'))
    assert.ok(streamAgentChatSource.includes("t: 'd'"))
    assert.ok(streamAgentChatSource.includes('finalResponse: requestedToolPreflightResponse'))
  })

  it('wires a bounded execution-kickoff continuation for intent-only live task replies', () => {
    assert.ok(streamSources.includes('execution_kickoff_followthrough'))
    assert.ok(streamAgentChatSource.includes('shouldForceExternalExecutionKickoffFollowthrough'))
    assert.ok(streamAgentChatSource.includes('externalExecutionKickoff'))
  })

  it('adds current-thread recall guidance and immediate memory routes in the system prompt', () => {
    assert.ok(streamAgentChatSource.includes('## Current Thread Recall'))
    assert.ok(streamAgentChatSource.includes('## Immediate Memory Routes'))
    assert.ok(streamAgentChatSource.includes('call `memory_store` or `memory_update` immediately before any planning, delegation, task creation, or agent management'))
    assert.ok(streamAgentChatSource.includes('Do NOT call memory tools, web search, or session-history tools'))
    assert.ok(streamAgentChatSource.includes('When assessing the platform, repo, runtime, or implementation status, inspect the relevant files, logs, or state first.'))
    assert.ok(streamAgentChatSource.includes('const currentThreadRecallRequest = isCurrentThreadRecallRequest(message)'))
    assert.ok(streamSources.includes('Preserve hard structural constraints from the original request'))
    assert.ok(streamAgentChatSource.includes('## Exact Structural Constraints'))
  })

  it('keeps silent-reply guidance scoped away from direct user chat', () => {
    assert.ok(streamAgentChatSource.includes('allowSilentReplies: isConnectorSession'))
    assert.ok(streamAgentChatSource.includes('Do not use it for greetings, direct questions, or when the user is clearly opening a conversation.'))
    assert.ok(streamAgentChatSource.includes('For direct user chats, always send a visible reply. Never answer with control tokens like NO_MESSAGE or HEARTBEAT_OK unless this is an explicit heartbeat poll.'))
  })

  it('canonicalizes required tool names when checking completion', () => {
    // The requiredToolsPending filter must canonicalize tool names so that
    // alias names (e.g. ask_human) match canonical names from LangGraph events.
    assert.ok(streamAgentChatSource.includes('canonicalizeExtensionId(toolName) || toolName'))
    assert.ok(streamAgentChatSource.includes('usedToolNames.has(toolName) && !') && streamAgentChatSource.includes('usedToolNames.has(canonical)'))
  })

  it('treats shell-based HTTP commands (curl/gh) as satisfying web research requirements', () => {
    // When shell runs curl/wget/gh, the web tool should be marked as used.
    assert.ok(streamAgentChatSource.includes("curl|wget|http|gh\\s+(issue|pr|api|repo|release|search|run)"))
    assert.ok(streamAgentChatSource.includes("usedToolNames.add('web')"))
  })
})

describe('shouldSkipToolSummaryForShortResponse', () => {
  it('skips forced tool-summary continuation for short responses after pure use_skill calls', () => {
    assert.equal(
      shouldSkipToolSummaryForShortResponse({
        fullText: 'HAL2K_RELEASE_LIVE_OK',
        toolEvents: [
          { name: 'use_skill', input: '{"action":"list"}', output: '{"ok":true}' },
          { name: 'use_skill', input: '{"action":"load"}', output: '{"loaded":true}' },
        ],
      }),
      true,
    )
  })

  it('does not skip tool-summary continuation when substantive tools also ran', () => {
    assert.equal(
      shouldSkipToolSummaryForShortResponse({
        fullText: 'Done.',
        toolEvents: [
          { name: 'use_skill', input: '{"action":"load"}', output: '{"loaded":true}' },
          { name: 'web', input: '{"q":"latest"}', output: 'results' },
        ],
      }),
      false,
    )
  })

  it('does not skip tool-summary continuation for empty text', () => {
    assert.equal(
      shouldSkipToolSummaryForShortResponse({
        fullText: '',
        toolEvents: [
          { name: 'use_skill', input: '{"action":"load"}', output: '{"loaded":true}' },
        ],
      }),
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

  it('does not surface successful memory-write tool output when tool calls finished without prose', () => {
    const result = resolveFinalStreamResponseText({
      fullText: '',
      lastSegment: '',
      lastSettledSegment: '',
      hasToolCalls: true,
      toolEvents: [
        {
          name: 'memory_tool',
          input: '{"action":"store","title":"Project Kodiak details"}',
          output: 'Stored memory "Project Kodiak details" (id: abc123). No further memory lookup is needed unless the user asked you to verify.',
        } as MessageToolEvent,
      ],
    })

    assert.equal(result, '')
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

describe('shouldForceWorkspaceScopeShellFallback', () => {
  it('forces a shell followthrough when files hit a workspace-scope boundary and shell is available', () => {
    assert.equal(
      shouldForceWorkspaceScopeShellFallback({
        userMessage: 'Append beta to /tmp/demo/notes.txt and leave /tmp/demo/summary.json intact.',
        finalResponse: 'The target path is outside the session workspace, so the `files` tool cannot access it.',
        enabledExtensions: ['files', 'shell'],
        toolEvents: [
          {
            name: 'files',
            input: '{"action":"read","filePath":"/tmp/demo/notes.txt"}',
            output: 'Error: target path is outside the session workspace. The files tool can only access paths under the workspace root in this chat. Use a workspace-relative path, or use shell if that external path truly needs machine-level access.',
          },
        ],
      }),
      true,
    )
  })

  it('does not force shell fallback once shell already ran', () => {
    assert.equal(
      shouldForceWorkspaceScopeShellFallback({
        userMessage: 'Append beta to /tmp/demo/notes.txt and leave /tmp/demo/summary.json intact.',
        finalResponse: 'Used shell to update the file.',
        enabledExtensions: ['files', 'shell'],
        toolEvents: [
          {
            name: 'files',
            input: '{"action":"read","filePath":"/tmp/demo/notes.txt"}',
            output: 'Error: target path is outside the session workspace. The files tool can only access paths under the workspace root in this chat. Use a workspace-relative path, or use shell if that external path truly needs machine-level access.',
          },
          {
            name: 'shell',
            input: '{"action":"execute","command":"printf ..."}',
            output: '(no output)',
          },
        ],
      }),
      false,
    )
  })

  it('builds a required-tool continuation prompt that explicitly redirects to shell for external paths', () => {
    const prompt = buildContinuationPrompt({
      type: 'required_tool',
      message: 'Append beta to /tmp/demo/notes.txt and leave /tmp/demo/summary.json intact.',
      fullText: 'The target path is outside the session workspace, so the `files` tool cannot access it.',
      toolEvents: [
        {
          name: 'files',
          input: '{"action":"read","filePath":"/tmp/demo/notes.txt"}',
          output: 'Error: target path is outside the session workspace. The files tool can only access paths under the workspace root in this chat. Use a workspace-relative path, or use shell if that external path truly needs machine-level access.',
        },
      ],
      requiredToolReminderNames: ['shell'],
      cwd: process.cwd(),
    })

    assert.match(String(prompt || ''), /Use `shell` now/i)
    assert.match(String(prompt || ''), /outside the session workspace/i)
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
    // After refactor: snapshot/restore is encapsulated in ChatTurnState class
    assert.ok(streamAgentChatSource.includes('state.snapshot()'))
    assert.ok(streamAgentChatSource.includes('state.restore(iterationStartState)'))
    // The snapshot captures all key fields
    assert.ok(streamAgentChatSource.includes('this.fullText = snap.fullText'))
    assert.ok(streamAgentChatSource.includes('this.lastSegment = snap.lastSegment'))
    assert.ok(streamAgentChatSource.includes('this.lastSettledSegment = snap.lastSettledSegment'))
    assert.ok(streamAgentChatSource.includes('this.needsTextSeparator = snap.needsTextSeparator'))
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

describe('resolveSuccessfulTerminalToolBoundary', () => {
  it('treats successful memory writes as terminal boundaries with one clean acknowledgement', () => {
    const result = resolveSuccessfulTerminalToolBoundary({
      toolName: 'memory_store',
      toolInput: { title: 'Launch marker', value: 'My launch marker is ALPHA-7.' },
      toolOutput: 'Stored memory "Launch marker" (id: abc123). No further memory lookup is needed unless the user asked you to verify.',
    })

    assert.equal(result?.kind, 'memory_write')
    assert.equal(result?.responseText, 'Your launch marker is ALPHA-7.')
  })

  it('does not treat successful memory writes as terminal when the turn has more work to do', () => {
    const result = resolveSuccessfulTerminalToolBoundary({
      toolName: 'memory_store',
      toolInput: { title: 'Launch marker', value: 'My launch marker is ALPHA-7.' },
      toolOutput: 'Stored memory "Launch marker" (id: abc123). No further memory lookup is needed unless the user asked you to verify.',
      allowMemoryWriteTerminal: false,
    })

    assert.equal(result, null)
  })

  it('treats durable ask_human waits as terminal boundaries', () => {
    assert.deepEqual(
      resolveSuccessfulTerminalToolBoundary({
        toolName: 'ask_human',
        toolInput: { action: 'wait_for_reply', correlationId: 'corr_123' },
        toolOutput: JSON.stringify({
          id: 'watch_123',
          type: 'mailbox',
          status: 'active',
          message: 'Durable wait registered.',
        }),
      }),
      { kind: 'durable_wait' },
    )
  })

  it('treats successful context compaction as a terminal boundary', () => {
    assert.deepEqual(
      resolveSuccessfulTerminalToolBoundary({
        toolName: 'context_summarize',
        toolInput: { keepLastN: 8 },
        toolOutput: '{"status":"compacted","remaining":9}',
      }),
      { kind: 'context_compaction' },
    )
  })
})

describe('buildSuccessfulMemoryMutationResponse', () => {
  it('renders a natural acknowledgement from first-person memory values', () => {
    assert.equal(
      buildSuccessfulMemoryMutationResponse({
        toolName: 'memory_store',
        toolInput: { value: 'My launch marker is ALPHA-7.' },
      }),
      'Your launch marker is ALPHA-7.',
    )
  })

  it('falls back to a single generic acknowledgement for fragmentary stored values', () => {
    assert.equal(
      buildSuccessfulMemoryMutationResponse({
        toolName: 'memory_store',
        toolInput: { title: 'User profile', value: 'Wayde with 4 cats' },
      }),
      'I\'ll remember that.',
    )
  })

  it('handles nested memory-tool style inputs without surfacing raw storage wording', () => {
    assert.equal(
      buildSuccessfulMemoryMutationResponse({
        toolName: 'memory_store',
        toolInput: {
          input: JSON.stringify({
            title: 'User Wayde regression marker',
            content: 'Wayde\'s regression marker is LIVE_MEM_DUP_123',
            category: 'identity/preferences',
          }),
        },
      }),
      'I\'ll remember that.',
    )
  })
})

describe('pruneIncompleteToolEvents', () => {
  it('drops unfinished tool-call stubs while preserving completed events', () => {
    const events: MessageToolEvent[] = [
      { name: 'memory_store', input: '{"title":"A"}', toolCallId: 'call-1' },
      { name: 'memory_store', input: '{"title":"A"}', toolCallId: 'call-2', output: 'Stored memory "A"' },
      { name: 'connector_message_tool', input: '{"action":"send"}', toolCallId: 'call-3', output: '' },
    ]

    assert.deepEqual(pruneIncompleteToolEvents(events), [
      { name: 'memory_store', input: '{"title":"A"}', toolCallId: 'call-2', output: 'Stored memory "A"' },
      { name: 'connector_message_tool', input: '{"action":"send"}', toolCallId: 'call-3', output: '' },
    ])
  })
})

describe('shouldForceExternalServiceSummary', () => {
  it('forces a summary when an external-service run ends with an unfinished exploration sentence', () => {
    assert.equal(
      shouldForceExternalServiceSummary({
        userMessage: 'Try to interact with the Hyperliquid API and stop at the blocker.',
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
        userMessage: 'Try to interact with the Hyperliquid API and stop at the blocker.',
        finalResponse: 'Last reversible step: I verified the funded Arbitrum account and opened the site. Exact blocker: this runtime cannot complete a signature prompt.',
        hasToolCalls: true,
        toolEventCount: 6,
      }),
      false,
    )
  })
})

describe('shouldForceExternalExecutionFollowthrough', () => {
  const researchToolEvents = [
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
          { name: 'http_request', input: '{"method":"GET","url":"https://api.0x.org/swap/v1/quote"}', output: '{"status":404}' },
          { name: 'http_request', input: '{"method":"GET","url":"https://apiv5.paraswap.io/prices"}', output: '{"status":400}' },
          { name: 'http_request', input: '{"method":"POST","url":"https://api.odos.xyz/sor/quote/v2"}', output: '{"status":200}' },
        ],
      }),
      true,
    )
  })

})

describe('shouldForceExternalExecutionKickoffFollowthrough', () => {
  it('forces a bounded continuation when an execution task stops at an intent-only kickoff', () => {
    assert.equal(
      shouldForceExternalExecutionKickoffFollowthrough({
        userMessage: 'Try to interact with the NFT marketplace API and show me what happened.',
        finalResponse: 'Let me try to interact directly with the NFT contract and see if I can mint one:',
        hasToolCalls: false,
        toolEvents: [],
      }),
      true,
    )
  })

  it('does not force kickoff when the model already surfaced a real blocker or asked a blocking question', () => {
    assert.equal(
      shouldForceExternalExecutionKickoffFollowthrough({
        userMessage: 'Try to interact with the NFT marketplace API and show me what happened.',
        finalResponse: 'Exact blocker: this runtime cannot complete the required signature step.',
        hasToolCalls: false,
        toolEvents: [],
      }),
      false,
    )
    assert.equal(
      shouldForceExternalExecutionKickoffFollowthrough({
        userMessage: 'Try to interact with the NFT marketplace API and show me what happened.',
        finalResponse: 'Which collection do you want me to target?',
        hasToolCalls: false,
        toolEvents: [],
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
        enabledExtensions: ['web', 'browser'],
        hasToolCalls: false,
        hasAttachmentContext: true,
      }),
      true,
    )
    assert.equal(
      shouldForceAttachmentFollowthrough({
        userMessage: 'Research the URL shown in the attached screenshot and inspect it in the browser.',
        enabledExtensions: ['web', 'browser'],
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
        enabledExtensions: ['web', 'browser'],
        hasToolCalls: false,
        hasAttachmentContext: false,
      }),
      false,
    )
    assert.equal(
      shouldForceAttachmentFollowthrough({
        userMessage: 'Look up my ally code from the attached screenshot.',
        enabledExtensions: ['web', 'browser'],
        hasToolCalls: true,
        hasAttachmentContext: true,
      }),
      false,
    )
    assert.equal(
      shouldForceAttachmentFollowthrough({
        userMessage: 'What does this screenshot say?',
        enabledExtensions: ['web', 'browser'],
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

  it('forces followthrough for terse follow-up prompts when file work started but the response is only a preamble', () => {
    assert.equal(
      shouldForceDeliverableFollowthrough({
        userMessage: 'Can you make it more complex and maybe use one of the CLI tools?',
        finalResponse: "I'll create a more sophisticated multi-page React application with proper project structure. Let me use shell commands to set up a proper build pipeline.",
        hasToolCalls: true,
        toolEvents: [
          { name: 'files', input: '{"action":"write","filePath":"wikipedia-explorer/src/App.jsx"}', output: '{"ok":true}' },
          { name: 'shell', input: '{"command":"cd wikipedia-explorer && npm install"}', output: 'added 65 packages' },
        ],
      }),
      true,
    )
  })

  it('forces followthrough for terse continuation prompts when recent user history shows a deliverable task', () => {
    assert.equal(
      shouldForceDeliverableFollowthrough({
        userMessage: 'Can you continue with the next pass?',
        finalResponse: "I'll keep going from here.",
        hasToolCalls: true,
        toolEvents: [
          { name: 'browser', input: '{"action":"screenshot"}', output: '{"path":"/tmp/topic.png"}' },
          { name: 'web', input: '{"action":"fetch","url":"https://example.com/topic"}', output: '<html>topic</html>' },
        ],
        history: [
          { role: 'user', text: 'Research 3 topics, take screenshots, write markdown and PDF files, then build a site for each topic.', time: Date.now() },
        ],
      }),
      true,
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

describe('resolveExclusiveMemoryWriteTerminalAllowance', () => {
  it('allows terminal memory acknowledgements when the user turn is a pure memory write', async () => {
    let captured: DirectMemoryIntentClassifierInput | null = null
    const allowed = await resolveExclusiveMemoryWriteTerminalAllowance({
      sessionId: 'sess-1',
      agentId: 'agent-1',
      message: 'Please remember that my launch marker is ALPHA-9.',
      classifyMemoryIntent: async (input) => {
        captured = input
        return {
          action: 'store',
          confidence: 0.99,
          value: 'My launch marker is ALPHA-9',
          acknowledgement: 'I\'ll remember that.',
          exclusiveCompletion: true,
        }
      },
    })

    assert.equal(allowed, true)
    assert.deepEqual(captured, {
      sessionId: 'sess-1',
      agentId: 'agent-1',
      message: 'Please remember that my launch marker is ALPHA-9.',
      currentResponse: '',
      currentError: null,
      toolEvents: [],
    })
  })

  it('keeps memory writes non-terminal when the user also asked for more work', async () => {
    const allowed = await resolveExclusiveMemoryWriteTerminalAllowance({
      sessionId: 'sess-2',
      message: 'Remember this, then continue auditing the platform.',
      classifyMemoryIntent: async () => ({
        action: 'store',
        confidence: 0.91,
        value: 'Continue auditing the platform after remembering this.',
        acknowledgement: 'I\'ll remember that.',
        exclusiveCompletion: false,
      }),
    })

    assert.equal(allowed, false)
  })

  it('fails closed when the classifier does not return an exclusive memory write', async () => {
    assert.equal(
      await resolveExclusiveMemoryWriteTerminalAllowance({
        sessionId: 'sess-3',
        message: 'What do you remember about me?',
        classifyMemoryIntent: async () => ({
          action: 'recall',
          confidence: 0.84,
          query: 'user profile',
          missResponse: 'I don\'t have that yet.',
        }),
      }),
      false,
    )

    assert.equal(
      await resolveExclusiveMemoryWriteTerminalAllowance({
        sessionId: 'sess-4',
        message: 'Remember this.',
        classifyMemoryIntent: async () => {
          throw new Error('classifier failed')
        },
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

describe('transient provider retry coverage', () => {
  it('treats upstream 500 and 429 class failures as transient retry candidates', () => {
    assert.ok(streamAgentChatSource.includes('InternalServerError'))
    assert.ok(streamAgentChatSource.includes('RateLimitError'))
    assert.ok(streamAgentChatSource.includes('too many requests'))
    assert.ok(streamAgentChatSource.includes('internal server error'))
  })
})

// ---------------------------------------------------------------------------
// Message classifier tests
// ---------------------------------------------------------------------------

describe('parseClassificationResponse', () => {
  it('parses valid classification JSON', () => {
    const result = parseClassificationResponse(JSON.stringify({
      isDeliverableTask: true,
      isBroadGoal: false,
      hasHumanSignals: false,
      hasSignificantEvent: false,
      isResearchSynthesis: true,
      explicitToolRequests: ['web'],
      confidence: 0.9,
    }))
    assert.ok(result)
    assert.equal(result.isDeliverableTask, true)
    assert.equal(result.isBroadGoal, false)
    assert.equal(result.isResearchSynthesis, true)
    assert.deepEqual(result.explicitToolRequests, ['web'])
    assert.equal(result.confidence, 0.9)
  })

  it('extracts JSON from markdown code block', () => {
    const text = '```json\n{"isDeliverableTask":false,"isBroadGoal":false,"hasHumanSignals":false,"hasSignificantEvent":false,"isResearchSynthesis":false,"explicitToolRequests":[],"confidence":0.8}\n```'
    const result = parseClassificationResponse(text)
    assert.ok(result)
    assert.equal(result.isDeliverableTask, false)
    assert.equal(result.confidence, 0.8)
  })

  it('returns null for invalid JSON', () => {
    assert.equal(parseClassificationResponse('not json'), null)
    assert.equal(parseClassificationResponse(''), null)
  })

  it('returns null for missing required fields', () => {
    const result = parseClassificationResponse('{"isDeliverableTask": true}')
    assert.equal(result, null)
  })

})

describe('message classifier adapter functions', () => {
  const deliverableClassification: MessageClassification = {
    taskIntent: 'general',
    isDeliverableTask: true,
    isBroadGoal: true,
    hasHumanSignals: false,
    hasSignificantEvent: false,
    isResearchSynthesis: false,
    explicitToolRequests: [],
    confidence: 0.95,
  }

  const humanSignalClassification: MessageClassification = {
    taskIntent: 'general',
    isDeliverableTask: false,
    isBroadGoal: false,
    hasHumanSignals: true,
    hasSignificantEvent: true,
    isResearchSynthesis: false,
    explicitToolRequests: [],
    confidence: 0.85,
  }

  it('isDeliverableTask prefers classification over regex', () => {
    // Classification says true, even for a message regex would reject
    assert.equal(isDeliverableTask(deliverableClassification, 'tell me a joke'), true)
    // Classification says false
    assert.equal(isDeliverableTask({ ...deliverableClassification, isDeliverableTask: false }, 'tell me a joke'), false)
  })

  it('isDeliverableTask falls back to regex when classification is null', () => {
    assert.equal(isDeliverableTask(null, 'Write a competitive analysis report and save to analysis.md'), true)
    assert.equal(isDeliverableTask(null, 'Hi'), false)
  })

  it('isBroadGoal prefers classification over regex', () => {
    assert.equal(isBroadGoal(deliverableClassification, 'short'), true)
    assert.equal(isBroadGoal({ ...deliverableClassification, isBroadGoal: false }, 'short'), false)
  })

  it('hasHumanSignals uses classification', () => {
    assert.equal(hasHumanSignals(humanSignalClassification, 'anything'), true)
    assert.equal(hasHumanSignals({ ...humanSignalClassification, hasHumanSignals: false }, 'anything'), false)
  })

  it('hasHumanSignals falls back to regex when null', () => {
    assert.equal(hasHumanSignals(null, 'my wife and I are moving next week'), true)
    assert.equal(hasHumanSignals(null, 'what is 2+2'), false)
  })

  it('hasSignificantEvent uses classification', () => {
    assert.equal(hasSignificantEvent(humanSignalClassification, 'anything'), true)
    assert.equal(hasSignificantEvent({ ...humanSignalClassification, hasSignificantEvent: false }, 'anything'), false)
  })

  it('isResearchSynthesis uses classification', () => {
    const researchClass: MessageClassification = { ...deliverableClassification, isResearchSynthesis: true }
    assert.equal(isResearchSynthesis(researchClass, null), true)
    assert.equal(isResearchSynthesis({ ...researchClass, isResearchSynthesis: false }, null), false)
  })

  it('isResearchSynthesis falls back to routing intent when null', () => {
    assert.equal(isResearchSynthesis(null, 'research'), true)
    assert.equal(isResearchSynthesis(null, 'browsing'), true)
    assert.equal(isResearchSynthesis(null, 'coding'), false)
  })
})
