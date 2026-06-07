# SwarmClaw Operator Failure Catalog

Last verified: 2026-06-07

Audience: Codex and future agents operating Zmey's local SwarmClaw instance.

Purpose: a compact list of known operator failure modes, their causes, and how to avoid repeating them. This catalog is sanitized and does not contain secrets.

Date convention: operator doc dates use Zmey's local Europe/Sofia calendar date unless a timestamp explicitly says UTC. Docker, task, and API timestamps may display UTC or epoch milliseconds.

## Use Pattern

When a task, run, browser check, or GUI action fails:

1. Preserve the task/run/session IDs.
2. Classify the failure family before retrying.
3. Check this catalog for a known cause.
4. Fix the root cause or change the procedure.
5. Save a concise agentmemory lesson only after the fix is verified.

## Catalog

| ID | Symptom | Verified or likely cause | Prevention | Recovery |
|---|---|---|---|---|
| F001 | Task becomes `process_lost` after being created or queued outside the GUI. | One-off shell imports of route/task services can bypass the live app context and interact badly with daemon orphan recovery. | Create and queue normal tasks through the GUI or authenticated app/API path. | Do not retry blindly. Inspect sanitized task/run metadata, then use a checkpointed state/API repair path only if needed. |
| F002 | Task output contains the requested marker but quality gate still fails. | Validator required concrete evidence signals, not only a marker or vague claim. | Include specific evidence fields in the prompt: tool, route, HTTP status, final URL/ready signal, page errors, request failures, verification phrase. | Retry only after prompt/gate alignment is approved. Browser evidence support is live in image `12b0d5eafd66`. |
| F003 | Newly created task does not run. | New Task creates a backlog item by default. | After creating the task, close the sheet and use the card `Queue` button. | Verify status from GUI and sanitized metadata. If status did not change, treat queueing as failed. |
| F004 | In-app browser automation cannot call `fetch` from page evaluation. | The protected in-app browser evaluation surface may not expose `fetch`. | Prefer visible GUI controls for authenticated writes. | Ask before using direct API or state paths. |
| F005 | Browser sweep reports an empty or incomplete page. | Waiting for `domcontentloaded` alone can read the shell before the app route is ready. | Wait for route-specific text or landmarks. | Re-run the read-only check with a stable ready signal. |
| F006 | Clicking `Queue`, `View`, or another task-board control affects nothing or the wrong item. | Board columns can be offscreen; generic locators can match hidden or duplicated controls. | Prefer List view or scoped locators tied to the target card title. | Verify status after every action. Do not assume a coordinate click worked. |
| F007 | CLI worker cannot access an in-app Knowledge source. | In-app Knowledge may not be available to CLI workers as MCP resources. | Include a short sanitized excerpt and source title in the task prompt. | Use the excerpt as the operative source; update Knowledge separately only after checkpoint. |
| F008 | A task asks a CLI worker to `use_skill`, but the tool is unavailable. | Codex CLI task execution may not expose the SwarmClaw `use_skill` tool. | Pin managed skills to the worker when the body must be in the first prompt, or embed a short excerpt. | Treat discoverable-only skills as insufficient for CLI task prompt injection. |
| F009 | Worker browser reaches `/login` instead of the target protected GUI page. | Worker browser is unauthenticated. | For protected GUI routes, make the access gate an allowed ready signal unless auth was checkpointed. | Do not read `.env.local` or enter access keys. Use main operator browser for authenticated GUI inspection. |
| F010 | OpenCode task exits successfully but has no useful assistant text. | `opencode-go/deepseek-v4-flash` has shown blank successful headless runs. | Avoid that provider/model for normal work. | Reassign to Builder, Reviewer QA, Copilot Mini Worker, or a verified OpenCode model. |
| F011 | Coordinator does not spawn stored worker agents. | Current CLI providers are normalized as worker-only, so stored Coordinator is not a true `spawn_subagent` coordinator. | Use direct managed task assignment by exact agent ID. | Treat Coordinator as planning/triage convention until a separate product/provider change is checkpointed. |
| F012 | Handoff becomes too large for future agents to use quickly. | Detailed run history was added to the concise external handoff instead of repo docs. | Keep the external handoff to one or two durable lines. | Move details into repo docs, then replace the handoff with a short summary after approval. |
| F013 | Post-run working-state or autonomy enrichment warns for CLI-backed agents. | Enrichment paths may need a generation-compatible model. Earlier missing-generation warnings were patched to skip quietly when no compatible model exists. | Monitor sanitized logs after CLI tasks. | If warnings return, classify whether task output is affected before touching provider routing. |
| F014 | Knowledge source sync appears successful but content stays stale. | Some Knowledge sources store inline content, so pressing sync may not reread the repo file. | Treat Knowledge content updates as explicit state mutations. | After checkpoint, update the stored source content or replace/supersede the source. |
| F015 | Direct assignment lands on the wrong agent. | Assignment-like phrases in the description can be parsed as reassignment hints. | Set the agent in the payload/GUI selector and avoid `assigned to`, `agent:`, `agent id:`, or `for agent` phrasing in the prose. | Verify stored `agentId` immediately after creation. |
| F016 | A worker cannot see newly edited repo docs. | Task workspaces/runtime image may not include the newest repo file until staged, copied, rebuilt, or embedded. | Embed short sanitized excerpts for must-have instructions. | Rebuild, stage, or sync only after checkpoint; otherwise provide the excerpt in the task. |
| F017 | In-app browser automation cannot type into New Task fields. | The browser automation surface can require a virtual clipboard that is not installed. | Do not keep retrying `fill`, `type`, or focused text entry after the virtual-clipboard error. Prefer manual GUI entry or a visible control path when available. For checkpointed diagnostics, use the app service/API path instead of raw DB writes. | Close any unsaved dialog, verify no partial task was created, then use the checkpointed fallback only if a task-state smoke is still required. Smoke `5780ab13` confirmed the service/API fallback. |
| F018 | Read-only planning task dead-letters as a screenshot delivery task. | Older validator builds could treat bare `capture` plus a `Return` section as screenshot delivery requiring artifact evidence. | For planning/task-template prompts, keep using `visual evidence` or `quick entry` wording. Rebuilt image `bfd26f21dfde` narrows detection to screenshot-delivery phrases. | Do not retry the same failed prompt. Use corrected wording and verify task output. Failed dry-run `9512d09a` exposed this; smoke `29a75b89` verified the rebuilt fix. |
| F019 | Completed task output misses final sections or evidence marker. | Stored task result can be truncated around 4,000 characters. Long plans may lose the final marker and handoff details. | Put evidence markers in the first ten lines and keep planning/review results under 2,500 characters. | Treat the task as partially useful, then rerun with a concise report shape if marker/sections are required. Dry-run `ae07aaa4` exposed this. |
| F020 | Reasoning-only planning task produces useful output but dead-letters on quality evidence. | The validator can classify planning language like `create`, `write`, or `improve` as implementation-like, then require two evidence categories. | For pure reasoning/planning tasks, explicitly disable or relax the per-task quality gate and manually verify marker, headings, and constraints. For implementation/QA tasks, keep evidence gates on. | Task `7a9e740f` failed with marker present and 1/2 evidence signals. Rerun `47b33926` used `qualityGate.enabled=false`, completed with `validation.ok=true`, and confirmed no tools or writes. Clean reference task `52cbb9bd` completed with marker first and `validation.ok=true`. |
| F021 | Planning task with useful output retries or dead-letters during app-delivery drills. | Words such as `app build`, `implementation`, or similar implementation hints can trigger the default quality gate; source-free planning output may count as only one evidence signal. | Avoid implementation-trigger wording in pure planning titles/prompts, or include source-path evidence plus `Verification: ... ok`. Add `Do not echo this prompt or announce that you are starting.` | Task `9beeb223` failed with marker present and 1/2 evidence signals. Corrected task `eab3d1f4` passed after source-path evidence and validator-friendly wording. |
| F022 | Task result is a prompt echo plus "I'll begin working", then validation fails as incomplete. | CLI worker output can echo the task prompt or emit startup language, which matches incomplete-result detection. | Prompt explicitly: `Do not echo this prompt. Do not announce that you are starting. Return only the requested output.` | Corrected Planner task `eab3d1f4` first retried on this pattern, then completed after a clean retry. Keep future prompts concise and output-only. |
| F023 | GUI-created task appears assigned in the form but stored `agentId` is wrong. | The visible agent picker can fail to persist the intended selection under automation or ambiguous form state. | Verify stored `agentId` before queueing. If needed, use a leading `@Reviewer`/`@Reviewer QA` mention and verify resolution to `c2cd6ff9` before queueing. | Review task `652d6e28` passed but ran as Coordinator `default`, so it did not count as Reviewer QA evidence. Exact-agent task `834c0b94` used mention resolution, ran as Reviewer QA `c2cd6ff9`, and passed. |
| F024 | Task form says the quality gate is disabled, but a review/planning task still retries on quality evidence. | Older task form behavior saved disabled as `qualityGate: null`, which lets implementation-hint prompts use the default enabled gate. | Persist an explicit disabled gate object (`qualityGate.enabled=false`) for reasoning-only tasks, and keep implementation/QA gates enabled. | Task `a61873aa` first retried despite useful output. Setting explicit `qualityGate.enabled=false` made the retry complete with `validation.ok=true`; source patched so the task form now saves explicit disabled gate config. Rebuild/recreate on 2026-06-07 verified the patched source in `/app`. |
| F025 | A retrying task returns a valid marker/result, then dead-letters because validation reports a non-empty error field. | Older queue retry path could preserve a previous validation error into the next completion validation. | Current source clears the task error from the current run before completion validation, preserving real current-run errors while removing stale retry errors. If this returns, verify the live image contains `recordCurrentTaskRunError`. | Builder task `45f50512` exposed this: its result validated when the stale error was cleared. Corrected Builder task `baff42eb` completed with `validation.ok=true`. Rebuild/recreate on 2026-06-07 verified the patched live image. |
| F026 | Subscription Docker rebuild pauses for many minutes at a silent ownership layer. | Older `Dockerfile.subscription` copied full runner `node_modules` and ran `chown -R node:node /app /home/node`, touching about 3.4GB and 143k files. | Current source uses standalone runtime dependencies, `COPY --chown`, targeted writable-dir ownership, direct Playwright CLI calls, and ignores `state` in build context. Do not reintroduce the full runner `node_modules` copy unless a runtime smoke proves it is required. | Commit `71b363cd` reduced the live image to 5.21GB; targeted chown layer was 0.1s in the throwaway build, and the rebuilt live app passed health on localhost-only bindings. |
| F027 | Corrected task text appears inside an existing `Edit Task` sheet instead of a fresh task. | Automation clicked a generic `Task`/text target while a failed task context was active, opening the edit sheet. Unsaved typing can concatenate with the existing title/description. | Use the unique `+ New Task` control. Before typing, assert the sheet heading is `New Task`, not `Edit Task`, and that title/description fields are blank. | Click `Cancel` without saving, verify the concatenated text is gone, then reopen through `+ New Task`. This recovery was verified on 2026-06-07 before creating the corrected smoke task. |

## Current Known Failure Signals

| Signal | Status | Operator stance |
|---|---|---|
| `Builder read-only queue smoke test` | Known validation mismatch, not provider failure. | Leave as evidence or retry only with validator-friendly prompt after checkpoint. |
| `Prime Number Function` quality gate | Blocked because no eval runs/baselines exist. | Do not run evals or set baselines without checkpoint. |
| Historical Autonomy incidents | Known incidents from task/quality failures and user-stopped runs. | Read-only monitor unless Zmey requests remediation. |
| Credential-secret mismatch warning | Sanitized warning only; no values inspected. | Checkpoint and backup before any credential/env alignment. |
| `SwarmClaw Understanding Sprint 01` first pass | Quality-gate mismatch, not provider failure. | Use F020 pattern for reasoning-only planning tasks; keep implementation gates strict. |
| `Parallel drill planner read-only` | Known prompt/validator mismatch, not provider failure. | Use F021/F022 prompt rules and verify `validation.ok`. |
| `Parallel drill reviewer gate corrected` | Completed but misassigned to Coordinator. | Do not count as Reviewer QA evidence; use F023 exact-agent verification. |
| `Reviewer QA orchestration readiness check` | First pass hit the disabled-quality-gate/null mismatch. | Fixed by F024; future task-form disabled gates should persist `qualityGate.enabled=false`. |
| `Parallel app-build drill Builder plan` | Returned a useful marker/result but dead-lettered on stale retry error. | Use F025; count corrected Builder task `baff42eb`, not failed task `45f50512`, as clean Builder evidence. |
| `Reviewer QA optimized image browser smoke 2026-06-07` | First prompt retried and dead-lettered on 1/2 quality-gate evidence signals. | Use F002/F027 corrected pattern: create a fresh task through `+ New Task`, then require command/tool evidence, file/path evidence, and browser/HTTP verification evidence in the first ten result lines. Corrected smoke completed with marker `SWARMCLAW_OPTIMIZED_IMAGE_REVIEWER_QA_SMOKE_CORRECTED_OK`. |

## After A New Failure

Add a new row only after the cause and prevention are verified. Include:

- symptom
- cause
- prevention
- recovery
- task/run/session IDs if useful and non-sensitive
- verification marker or command

Do not add raw logs, secrets, credential values, full env output, auth JSON, private keys, or raw database rows.
