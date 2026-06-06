---
name: swarmclaw-webapp-testing
description: Use on Zmey's local SwarmClaw instance when planning or performing safe browser verification of local web apps, SwarmClaw GUI pages, or worker-delivered frontend changes.
tags: [swarmclaw, browser-testing, qa, playwright, local-only]
---

# SwarmClaw Webapp Testing

Verify browser-visible behavior with explicit evidence while keeping Zmey's SwarmClaw instance local-only.

This is SwarmClaw-local guidance. It adapts the public `webapp-testing` workflow from `ComposioHQ/awesome-claude-skills` to Zmey's local instance. The local operator manual, current handoff, `AGENTS.md`, and live runtime behavior win over this skill when they conflict.

## When To Use

Use this skill when:

- A task changes frontend behavior, UI routing, forms, task boards, Knowledge pages, logs, or other browser-visible surfaces.
- A worker claims a GUI feature is done and needs browser evidence.
- You need a repeatable read-only sweep of a local app page.
- A failing task needs route-level browser evidence before code changes.

Do not use it when:

- The target is purely backend or CLI behavior with no browser-visible surface.
- The next action would require secrets, auth JSON, raw env files, tokens, private keys, provider routing, schedules, autonomy, credentials, or public exposure settings.
- Verification would require killing, restarting, replacing, or exposing the SwarmClaw server on port `3456`.

## Non-Negotiables

- Keep SwarmClaw local-only. Never expose port `3456` publicly.
- Do not kill, restart, replace, or bind over the running SwarmClaw server on port `3456` without an explicit Zmey checkpoint.
- Use read-only checks by default. Do not submit forms, start runs, trigger schedules, create/delete records, reveal secrets, or change settings unless the task explicitly allows that exact action.
- Never inspect or print secrets, auth JSON, full env files, tokens, credential files, private keys, raw credential output, or hidden credential values.
- For sensitive pages such as Secrets, Providers, Wallets, Autonomy, and Settings, document visible controls and status only.
- For CLI-backed SwarmClaw workers, pin this managed skill to the worker if the body must be visible in the first task prompt. Do not rely on `use_skill` being available in Codex CLI task execution.
- Avoid `opencode-go/deepseek-v4-flash` for normal browser-testing worker tasks because headless runs can exit successfully without assistant text.
- CLI workers may have the Playwright package without a browser executable. If Chromium, Firefox, WebKit, or a system browser is missing, report the tooling gap and fall back to HTTP/readiness planning. Do not install browsers or packages without checkpoint.
- Current local status as of 2026-06-06: Playwright Chromium launches for Reviewer QA from the rebuilt `swarmclaw-subscription:1.9.36` image. `Dockerfile.subscription` installs Chromium dependencies and Playwright Chromium into `/home/node/.cache/ms-playwright`; rebuilt-image smoke task `a1c59af7` completed with `SWARMCLAW_WEBAPP_TESTING_REBUILT_IMAGE_OK`. Authenticated SwarmClaw GUI routes still redirect unauthenticated worker browsers to the access-key gate; do not read `.env.local` or enter an access key without a separate checkpoint.
- Do not create or queue normal browser-test tasks by importing SwarmClaw route services from a one-off shell process. Use the GUI or authenticated app/API task path. If a diagnostic service path is checkpointed, self-monitor it to terminal state and verify sanitized task metadata so daemon orphan recovery does not turn the task into `process_lost`.

## Source Audit

Audited external source:

- Source: `https://github.com/ComposioHQ/awesome-claude-skills/tree/master/webapp-testing`
- `SKILL.md` blob SHA checked: `4726215301db64a0cc4d41fc3219c61f37a30f4a`
- `scripts/with_server.py` blob SHA checked: `431f2eba16b268b7f3e2ae4daae9db41c0289b6d`
- Per-skill license file checked: Apache License 2.0, blob SHA `7a4a3ea2424c09fbe48d455aed1eaa94d9124835`

Decision: adapt the verification workflow only. Do not import the upstream server lifecycle helper for SwarmClaw port `3456`, because starting and terminating servers is checkpoint-required in this local setup.

## Default Verification Flow

### 1. Define Scope

Write down:

- target URL
- viewport size
- expected route-specific ready signal
- allowed actions
- forbidden actions
- evidence to collect
- pass/fail criteria

If the task does not provide these, choose the smallest safe read-only route and report the assumption.

### 2. Check Health And Binding

Before testing SwarmClaw itself, verify:

- `http://127.0.0.1:3456/api/healthz` returns ok
- Docker or process binding is localhost-only

Do not restart the server if either check fails. Report the failure and the safest next action.

### 3. Open The Page

Use the safest available browser tool for the current operator environment:

- Main Codex operator: prefer the in-app Browser for local targets.
- SwarmClaw worker with browser tooling: use that browser tooling inside the task workspace.
- Scripted verification: use Playwright only inside the allowed target workspace and only after confirming any required server is already running or explicitly approved.

After navigation, wait for a route-specific app signal, not only generic page load. Examples:

- `/tasks`: visible task board, columns, or task titles.
- `/knowledge`: Knowledge source list, source detail, or source actions.
- `/logs`: log viewer text, filters, or live log rows.
- App under test: the page heading, stable landmark, button label, or test id that proves the route rendered.

Waiting only for `domcontentloaded` can produce false empty-page observations.

### 4. Inspect Read-Only State

Collect only what the task needs:

- page title and URL
- visible headings and primary controls
- route-specific ready signal
- console errors or warnings relevant to the target
- network failures relevant to the target
- screenshot path if screenshots are available
- DOM snippets only when they do not expose secrets or private data

Never dump whole pages, hidden fields, credential tables, or full logs when a concise finding is enough.

### 5. Exercise Allowed Interactions

Only perform interactions listed in the task scope. Safe examples:

- open a read-only details panel
- switch filters that do not persist settings
- navigate between read-only pages
- search within a list if no state is changed
- hover or inspect tooltips

Checkpoint-required examples:

- save, delete, archive, sync, import, retry, cancel, run, approve, reject, start, stop, deploy, expose, connect, install, pin, attach, or edit runtime state
- form submission
- changing schedules, autonomy, providers, credentials, settings, tasks, or state DB
- starting or stopping a dev server

### 6. Report Evidence

Use this report shape:

```markdown
Target URL:
Viewport:
Ready signal:
Actions performed:
Assertions:
Console/network findings:
Screenshot/evidence:
Files changed:
Risk or follow-up:
Result:
Evidence marker:
```

For successful smoke tasks, use a unique marker:

```text
SWARMCLAW_WEBAPP_TESTING_[AREA]_[SHORT_GOAL]_OK
```

Use `SWARMCLAW_WEBAPP_TESTING_PINNED_SKILL_OK` only when this pinned managed skill was visible in the worker prompt and actually guided the task.

## Common Playbooks

### Read-Only SwarmClaw Page Smoke

1. Verify health and localhost-only binding.
2. Open the target URL on `127.0.0.1:3456`.
3. Wait for route-specific text.
4. Record visible controls and any page-specific status.
5. Check console for relevant errors if tooling supports it.
6. Do not click state-changing controls.
7. Report pass/fail with evidence.

### Worker Frontend Completion Review

1. Read the worker's claimed result and changed files.
2. Identify the smallest route or workflow that proves the claim.
3. Run a read-only browser check first.
4. If mutation is required to verify the change, request checkpoint with the exact action.
5. Compare observed behavior to acceptance criteria.
6. Return findings ordered by severity.

### Failed Browser Task Triage

1. Preserve the failing task ID and result.
2. Identify whether failure is setup, navigation, render readiness, missing tool, provider output, app bug, or assertion mismatch.
3. Recheck with a route-specific ready signal.
4. Avoid retry loops until the failure family is known.
5. Save a durable lesson only after the cause and prevention are verified.

### New App Under Test

1. Determine whether the app is static or requires a dev server.
2. If static, open the file or local URL directly.
3. If a dev server is needed, use an existing running server or request checkpoint before starting one.
4. Use a non-conflicting localhost port if a server start is approved.
5. Do not expose the server publicly.
6. Capture screenshot, console, and targeted assertions.

## Task Prompt Template

```markdown
You are working inside Zmey's local SwarmClaw instance.

Task: browser verification of [target]
Allowed scope: read-only unless explicitly stated otherwise.
Target URL: [url]
Viewport: [desktop/mobile size]
Ready signal: [route-specific text or landmark]
Forbidden actions: no form submission, no state changes, no secret inspection, no server restart.

Rules:
- Follow AGENTS.md.
- Keep SwarmClaw local-only; never expose port 3456 publicly.
- Do not inspect or print secrets, auth JSON, full env files, tokens, credential files, private keys, or raw credential output.
- Do not kill, restart, or replace the dev server on port 3456.
- Do not change providers, credentials, schedules, autonomy, settings, tasks, state DB, or public exposure without checkpoint.
- If blocked, report the blocker and the safest next action.

Expected output:
- Target URL and viewport.
- Ready signal observed.
- Actions performed.
- Assertions and findings.
- Console/network issues, if checked.
- Files changed, or "none".
- Browser/tool, target route, HTTP status, final URL or ready signal, and page/request failure counts.
- Evidence marker: SWARMCLAW_WEBAPP_TESTING_[AREA]_[SHORT_GOAL]_OK
```
