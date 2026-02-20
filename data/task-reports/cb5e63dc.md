# Task cb5e63dc: Task validation workflow - spawn verification checks after completion

- Status: completed
- Agent: fcd98bac
- Session: 78cc1b0c

## Description
Implement a validation workflow where tasks can spawn verification checks. Example: Codex completes WhatsApp image support → system spawns validation task to manually test sending an image. Could be a new agent spawn or a check that Hal performs. Prevents 'done' but not actually working scenarios.

## Result Summary
The plan adds a verification workflow with these key design decisions:

- **Per-task opt-in** via `autoVerify: boolean` — no per-agent defaults, keeps it simple
- **Auto-queue** — verification tasks spawn directly into `queued` and run automatically
- **Parent status propagation** — verification pass → parent moves to `verified`; verification fail → parent moves to `failed`
- **Guard against recursion** — verification tasks (those with `parentTaskId`) never spawn their own verification
- **6 files modified**, no new files needed

Two decisions I baked in that you might want to change:
1. Failed verification marks the parent as `failed` (alternative: parent stays `completed`)
2. Verification auto-queues immediately (alternative: lands in `backlog` for manual review)

## Changed Files
- Not provided

## Commands Run
- Not provided

## Verification
- The plan adds a verification workflow with these key design decisions:
- **Auto-queue** — verification tasks spawn directly into `queued` and run automatically
- **Parent status propagation** — verification pass → parent moves to `verified`; verification fail → parent moves to `failed`
- **Guard against recursion** — verification tasks (those with `parentTaskId`) never spawn their own verification
- 1. Failed verification marks the parent as `failed` (alternative: parent stays `completed`)
- 2. Verification auto-queues immediately (alternative: lands in `backlog` for manual review)
