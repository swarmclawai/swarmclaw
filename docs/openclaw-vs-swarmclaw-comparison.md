# OpenClaw vs SwarmClaw Feature Comparison

Generated: 2026-02-21

## Summary

OpenClaw and SwarmClaw share similar goals (personal AI assistant with multi-channel support) but differ significantly in architecture, scope, and focus.

**OpenClaw** = Personal AI assistant focused on WhatsApp/Telegram/Discord/iMessage with companion apps (macOS, iOS, Android). Gateway-centric architecture with Pi AI agent runtime.

**SwarmClaw** = Multi-agent orchestration dashboard with task queue, scheduling, and agent swarms. Web-centric architecture with multiple CLI/API providers.

---

## Feature Comparison Table

### Channels

| Feature | OpenClaw | SwarmClaw | Gap |
|---------|----------|-----------|-----|
| WhatsApp | ✅ Baileys, full featured | ✅ Baileys, basic | Media sending gaps |
| Telegram | ✅ grammY, full featured | ✅ grammy, basic | Photo/document sending |
| Discord | ✅ discord.js, full featured | ✅ discord.js, basic | Permission system |
| Slack | ✅ Bolt, full featured | ✅ @slack/bolt, basic | App home, modals |
| iMessage | ✅ BlueBubbles + legacy imsg | ❌ | **MISSING** |
| Signal | ✅ signal-cli | ❌ | **MISSING** |
| Google Chat | ✅ Chat API | ❌ | **MISSING** |
| Microsoft Teams | ✅ Bot Framework | ❌ | **MISSING** |
| Matrix | ✅ Extension | ❌ | **MISSING** |
| Zalo | ✅ Extension | ❌ | **MISSING** |
| WebChat | ✅ Built-in | ✅ Web UI | Similar |
| Email/Gmail | ✅ Gmail Pub/Sub hooks | ❌ | **MISSING** |

### Agent Features

| Feature | OpenClaw | SwarmClaw | Gap |
|---------|----------|-----------|-----|
| Agent runtime | Pi AI (bundled) | Multiple: Claude, Codex, OpenCode, APIs | Different approach |
| Multi-agent routing | ✅ Per-sender/workspace isolation | ✅ Agent assignment + swarms | Similar |
| Soul/personality | ✅ SOUL.md | ✅ Agent soul system | Similar |
| Thinking levels | ✅ `/think` command | ❌ | **MISSING** |
| Sandbox mode | ✅ Docker per non-main session | ❌ | **MISSING** |
| Elevated bash | ✅ Per-session toggle | ✅ Via shell tool | Similar |

### Tools

| Feature | OpenClaw | SwarmClaw | Gap |
|---------|----------|-----------|-----|
| Shell/bash | ✅ host.exec | ✅ execute_command | Similar |
| Browser control | ✅ Dedicated Chrome via CDP | ✅ Playwright via browser tool | Similar |
| Canvas | ✅ A2UI visual workspace | ❌ | **MISSING** |
| Nodes (iOS/Android/macOS) | ✅ camera, screen, location, notify | ❌ | **MISSING** |
| Cron/scheduling | ✅ Wakeups + cron | ✅ Schedules + daemon | Similar |
| Webhooks | ✅ Inbound webhook surface | ✅ Webhook registration | Similar |
| Memory | ✅ Per-session memory | ✅ Memory tool + vector search | Similar |
| Sessions tool | ✅ sessions_* for agent-to-agent | ✅ sessions_tool | Similar |
| Skills | ✅ SKILL.md + ClawHub | ✅ Skills system + import | Similar |
| Plugins | ✅ JS hooks | ✅ JS hooks (compatible) | Same format |

### Companion Apps

| Feature | OpenClaw | SwarmClaw | Gap |
|---------|----------|-----------|-----|
| macOS app | ✅ Menu bar + voice wake | ❌ | **MISSING** |
| iOS app | ✅ Node + Canvas | ❌ | **MISSING** |
| Android app | ✅ Node + Canvas + camera | ❌ | **MISSING** |
| Voice wake | ✅ Always-on speech | ❌ | **MISSING** |
| Talk mode | ✅ Continuous conversation | ❌ | **MISSING** |

### Platform/Architecture

| Feature | OpenClaw | SwarmClaw | Gap |
|---------|----------|-----------|-----|
| Web dashboard | ✅ Control UI | ✅ Full dashboard | SwarmClaw richer |
| Task board | ❌ | ✅ Kanban-style tasks | SwarmClaw advantage |
| Provider management | ❌ (single Pi agent) | ✅ 15+ providers | SwarmClaw advantage |
| Agent builder | ❌ | ✅ Full UI + AI generation | SwarmClaw advantage |
| Secrets vault | ❌ | ✅ Encrypted storage | SwarmClaw advantage |
| Cost tracking | ❌ | ✅ Per-message tokens | SwarmClaw advantage |
| Execution logs | ❌ | ✅ logs.db audit trail | SwarmClaw advantage |
| Tailscale integration | ✅ Serve/Funnel | ❌ | **MISSING** |
| Doctor/diagnostics | ✅ `openclaw doctor` | ✅ `swarmclaw setup doctor` + `/api/setup/doctor` | Narrowed gap |
| Gateway pairing | ✅ Bonjour + QR | ❌ | **MISSING** |

### Media/Rich Content

| Feature | OpenClaw | SwarmClaw | Gap |
|---------|----------|-----------|-----|
| Image receive | ✅ | ✅ | Similar |
| Image send | ✅ | ✅ (via connector_message_tool and connector media paths) | Smaller gap |
| Audio/voice notes | ✅ + transcription hook | ❌ | **MISSING** |
| Video | ✅ | ❌ | **MISSING** |
| Document handling | ✅ | ✅ upload endpoint | Similar |

### Session/Conversation

| Feature | OpenClaw | SwarmClaw | Gap |
|---------|----------|-----------|-----|
| Session isolation | ✅ Main + groups | ✅ Per-session isolation | Similar |
| Context compaction | ✅ Session pruning | ✅ context_summarize tool | Similar |
| Chat commands | ✅ `/status`, `/reset`, etc. | ❌ | **MISSING** |
| Typing indicators | ✅ | ❌ | **MISSING** |
| Presence | ✅ Online/typing | ❌ | **MISSING** |
| NO_MESSAGE suppression | ✅ | ✅ | Similar |

---

## Key Differences

### 1. Architecture Philosophy

**OpenClaw**: Gateway-centric
- Single control plane via WebSocket (`ws://127.0.0.1:18789`)
- Pi AI agent bundled as the default/only agent runtime
- All channels connect to the gateway
- Companion apps connect to the gateway
- Designed for personal, single-user use

**SwarmClaw**: Dashboard-centric
- Web UI as the primary interface
- Multiple agent providers (Claude, Codex, OpenAI, etc.)
- Task queue + daemon for background execution
- API-first with REST endpoints
- Designed for multi-agent orchestration

### 2. Channel Depth vs Breadth

**OpenClaw**: Depth
- Fewer channels but deeper integration
- Full media support (images, audio, video, documents)
- Typing indicators, presence
- Channel-specific features (BlueBubbles for iMessage, etc.)
- Voice note transcription hooks

**SwarmClaw**: Breadth
- More providers but lighter channel integration
- Connector layer supports text plus media attachments
- Media receiving and sending supported across major chat connectors
- Missing several major channels (iMessage, Signal, Teams, etc.)

### 3. Agent Runtime

**OpenClaw**: Pi AI
- Bundled, single agent model
- RPC mode with tool streaming
- Optimized for personal assistant workflows
- Simpler mental model

**SwarmClaw**: Multi-provider
- Choose from 15+ LLM providers
- CLI delegation (Claude Code, Codex, OpenCode)
- Agent builder with custom souls
- Task assignment to specific agents
- More complex but more flexible

### 4. Companion Apps

**OpenClaw**: Native apps
- macOS menu bar app with voice wake
- iOS/Android nodes with Canvas support
- Camera, screen recording, notifications
- Push-to-talk overlay
- Always-on voice listening

**SwarmClaw**: Web-only
- Mobile-friendly responsive web UI
- No native apps
- No voice integration (except TTS settings)
- Canvas not implemented

### 5. Security Model

**OpenClaw**: Sandboxed execution
- Main session has full access
- Non-main sessions can run in Docker sandbox
- Per-session elevated bash toggle
- DM pairing for unknown senders

**SwarmClaw**: Per-session permissions
- Tool toggle per session/agent
- Secrets vault for sensitive data
- Access key authentication
- No sandboxing/Docker isolation

---

## Missing Features in SwarmClaw

### Critical (blocks use cases)

1. **iMessage support** - BlueBubbles integration missing
2. **Voice/audio support** - No transcription hook, no voice notes
3. **Canvas** - No visual workspace for agents
4. **Mobile companion apps** - No iOS/Android nodes

### High Impact (improves experience)

5. **Chat commands** - No `/status`, `/reset`, `/think` etc.
6. **Typing indicators** - No presence/typing feedback on channels
7. **Tailscale integration** - No remote access via tailnet
8. **Signal support** - Missing privacy-focused channel
9. **Doctor/diagnostics** - Added setup diagnostics (`swarmclaw setup doctor`, `/api/setup/doctor`), but still lacks OpenClaw's device-level diagnostics depth

### Medium Impact (nice to have)

10. **Google Chat** - Missing enterprise channel
11. **Microsoft Teams** - Missing enterprise channel
12. **Matrix** - Missing federated channel
13. **Gmail hooks** - No email triggers
14. **Docker sandbox** - No isolated execution for non-main sessions
15. **Bonjour discovery** - No local network discovery
16. **Session pairing** - No QR/pairing flow for mobile

---

## SwarmClaw Advantages

OpenClaw doesn't have everything. Here's where SwarmClaw leads:

1. **Multi-provider support** - 15+ LLM providers vs single Pi agent
2. **Task board** - Kanban-style task management and queuing
3. **Agent builder** - Create custom agents with souls and tools
4. **Cost tracking** - Token usage and cost estimation per message
5. **Execution logging** - Structured audit trail in logs.db
6. **Daemon orchestration** - Background task processing
7. **Provider failover** - Automatic key rotation on rate limits
8. **Webhooks API** - Register external webhooks for events
9. **Documents/RAG** - Upload and search indexed documents
10. **Native scheduling** - Cron + interval + one-time schedules

---

## Recommendations

### Phase 1: Close Critical Gaps

1. **Voice/audio pipeline**
   - Add transcription hook like OpenClaw
   - Support voice note receive + transcribe
   - Optional: voice note send

2. **iMessage via BlueBubbles**
   - Implement BlueBubbles webhook connector
   - Support send/receive via BlueBubbles server

### Phase 2: Improve Channel Depth

3. **Chat commands**
   - Add `/status`, `/reset`, `/compact`, `/think` parsing
   - Process in connector layer before agent

4. **Typing indicators**
   - Send typing state to channels when agent is processing
   - Use channel APIs (Telegram, Discord support this)

6. **Presence system**
   - Track online/offline status
   - Show in dashboard

### Phase 3: Companion Experience

7. **Canvas implementation**
   - A2UI-style visual workspace
   - Agent-driven UI updates

8. **Mobile apps**
   - Start with web-first PWA
   - Consider React Native for native features

9. **Voice wake**
   - Browser-based wake word detection
   - Integration with TTS for talk mode

### Phase 4: Enterprise Features

10. **Signal connector**
    - Add signal-cli integration

11. **Microsoft Teams**
    - Bot Framework connector

12. **Gmail hooks**
    - Pub/Sub integration for email triggers

---

## Code-Level Differences (To Be Documented)

This section should be filled in after a deep code review:

- Session model implementation differences
- Tool execution patterns
- Agent loop architecture
- Channel protocol handling
- Memory/context management
- Plugin/skill architecture

---

## Conclusion

**OpenClaw** excels at:
- Personal AI assistant experience
- Mobile and voice integration
- Channel depth (media, typing, notifications)
- Native companion apps

**SwarmClaw** excels at:
- Multi-provider orchestration
- Task management and queuing
- Agent customization
- Web dashboard experience

The gap is primarily in **channel depth** (media, typing, presence) and **companion apps** (iOS, Android, macOS). The good news: these are additive features that don't require architectural changes. Start with media sending, then move to voice and native apps.
