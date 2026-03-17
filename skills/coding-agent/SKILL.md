---
name: coding-agent
description: 'Delegate coding tasks to external coding agents (Claude Code, Codex, Pi, OpenCode) via shell. Use when: (1) building new features or apps in a separate project, (2) reviewing PRs, (3) refactoring large codebases, (4) iterative coding that needs file exploration. NOT for: simple one-liner fixes (just edit directly), reading code (use read/file tools), or work inside the SwarmClaw workspace itself.'
metadata:
  {
    "openclaw": { "emoji": "🧩", "requires": { "anyBins": ["claude", "codex", "opencode", "pi"] } },
  }
---

# Coding Agent

Delegate coding tasks to external coding agents via shell tools.

## Agent Execution Modes

### Claude Code (recommended)

Use `--print --permission-mode bypassPermissions` for non-interactive execution:

```bash
cd /path/to/project && claude --permission-mode bypassPermissions --print 'Your task here'
```

For background execution, use the shell tool's background mode.

**Do NOT use PTY mode with Claude Code** — `--print` mode keeps full tool access and avoids interactive confirmation dialogs.

### Codex

Codex requires a git repository and PTY mode:

```bash
# Quick one-shot (auto-approves changes)
cd /path/to/project && codex exec --full-auto 'Build a dark mode toggle'

# Codex refuses to run outside a git directory. For scratch work:
SCRATCH=$(mktemp -d) && cd $SCRATCH && git init && codex exec "Your prompt"
```

### Pi Coding Agent

```bash
# Install: npm install -g @mariozechner/pi-coding-agent
cd /path/to/project && pi 'Your task'

# Non-interactive mode
pi -p 'Summarize src/'

# Different provider/model
pi --provider openai --model gpt-4o-mini -p 'Your task'
```

### OpenCode

```bash
cd /path/to/project && opencode run 'Your task'
```

## PR Reviews

Clone to a temp folder or use git worktree — never review PRs in the SwarmClaw project directory:

```bash
# Clone to temp for safe review
REVIEW_DIR=$(mktemp -d)
git clone https://github.com/user/repo.git $REVIEW_DIR
cd $REVIEW_DIR && gh pr checkout 130
codex review --base origin/main

# Or use git worktree
git worktree add /tmp/pr-130-review pr-130-branch
cd /tmp/pr-130-review && codex review --base main
```

## Parallel Issue Fixing

Use git worktrees to fix multiple issues in parallel:

```bash
# Create worktrees
git worktree add -b fix/issue-78 /tmp/issue-78 main
git worktree add -b fix/issue-99 /tmp/issue-99 main

# Launch agents (use background shell execution)
cd /tmp/issue-78 && codex --yolo 'Fix issue #78: <description>. Commit when done.'
cd /tmp/issue-99 && codex --yolo 'Fix issue #99: <description>. Commit when done.'

# Create PRs after
cd /tmp/issue-78 && git push -u origin fix/issue-78
gh pr create --repo user/repo --head fix/issue-78 --title "fix: ..." --body "..."

# Cleanup
git worktree remove /tmp/issue-78
git worktree remove /tmp/issue-99
```

## Rules

1. **Use the right execution mode per agent**: Claude Code uses `--print` (no PTY); Codex/Pi/OpenCode may need interactive terminal.
2. **Respect tool choice** — if the user asks for Codex, use Codex. Don't silently switch agents.
3. **Be patient** — don't kill sessions because they seem slow.
4. **Monitor progress** — check output periodically without interfering.
5. **Never run coding agents inside the SwarmClaw project directory** — use a separate project directory or temp folder.

## Progress Updates

When spawning coding agents in the background:

- Send a short message when you start (what's running, where).
- Update only when something changes (milestone, error, completion).
- If you kill a session, say so immediately and explain why.
