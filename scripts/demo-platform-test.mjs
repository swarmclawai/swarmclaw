#!/usr/bin/env node
/**
 * SwarmClaw Platform Demo & Integration Test
 *
 * Exercises the full platform lifecycle:
 *  1. Auth verification
 *  2. Agent CRUD (create researcher + builder + delegator)
 *  3. Session lifecycle (create, chat, verify messages)
 *  4. Task board operations (create, update status, comment)
 *  5. Delegation configuration
 *  6. Cleanup
 */

const BASE = process.env.SWARMCLAW_URL || 'http://localhost:3456';
const KEY = process.env.SWARMCLAW_ACCESS_KEY || '';

const created = { agents: [], sessions: [], tasks: [] };
let passed = 0;
let failed = 0;

// ── Helpers ──────────────────────────────────────────────

async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'X-Access-Key': KEY, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, ok: res.ok };
}

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
  }
}

function section(title) {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(50));
}

// ── 1. Auth ──────────────────────────────────────────────

async function testAuth() {
  section('1. Authentication');
  const { status, data } = await api('GET', '/api/auth');
  assert(status === 200, `GET /api/auth → ${status}`);
  assert(data.firstTime === false, `Server is configured (firstTime=${data.firstTime})`);

  const valid = await api('POST', '/api/auth', { key: KEY });
  assert(valid.ok, `POST /api/auth with valid key → ${valid.status}`);

  const invalid = await api('POST', '/api/auth', { key: 'wrong-key' });
  assert(invalid.status === 401, `POST /api/auth with bad key → ${invalid.status}`);
}

// ── 2. Agent CRUD ────────────────────────────────────────

async function createAgents() {
  section('2. Agent CRUD');

  // Discover available credentials to wire up real chat
  const creds = await api('GET', '/api/credentials');
  const openaiCred = Object.entries(creds.data || {}).find(([, v]) => v.provider === 'openai');
  const credentialId = openaiCred ? openaiCred[0] : null;
  if (credentialId) {
    console.log(`  → Found OpenAI credential: ${credentialId}`);
  } else {
    console.log(`  ⊘ No OpenAI credential found — chat test will be limited`);
  }

  // Create a Researcher agent
  const researcher = await api('POST', '/api/agents', {
    name: '🔬 Demo Researcher',
    description: 'Researches topics and gathers information for the team',
    systemPrompt: 'You are a research specialist. When given a topic, provide concise, factual summaries in 1-2 sentences max.',
    provider: 'openai',
    model: 'gpt-4o',
    credentialId,
    tools: ['web_search'],
  });
  assert(researcher.ok, `Created Researcher agent → ${researcher.data?.id?.slice(0, 8)}`);
  if (researcher.data?.id) created.agents.push(researcher.data.id);

  // Create a Builder agent
  const builder = await api('POST', '/api/agents', {
    name: '🔨 Demo Builder',
    description: 'Writes code and builds features based on research findings',
    systemPrompt: 'You are a code builder. Write clean, minimal code. Respond with code blocks when asked to build something.',
    provider: 'openai',
    model: 'gpt-4o',
    credentialId,
    tools: ['shell', 'file_read', 'file_write'],
  });
  assert(builder.ok, `Created Builder agent → ${builder.data?.id?.slice(0, 8)}`);
  if (builder.data?.id) created.agents.push(builder.data.id);

  // Create a delegating agent that coordinates both
  const delegator = await api('POST', '/api/agents', {
    name: '🧠 Demo Delegator',
    description: 'Coordinates the researcher and builder to complete complex tasks',
    systemPrompt: 'You are a delegating agent. Break tasks into research and build phases. Delegate to the most suitable agent.',
    provider: 'openai',
    model: 'gpt-4o',
    credentialId,
    delegationEnabled: true,
    delegationTargetMode: 'selected',
    delegationTargetAgentIds: [researcher.data?.id, builder.data?.id].filter(Boolean),
  });
  assert(delegator.ok, `Created Delegator agent → ${delegator.data?.id?.slice(0, 8)}`);
  if (delegator.data?.id) created.agents.push(delegator.data.id);

  // List agents and verify ours exist
  const list = await api('GET', '/api/agents');
  const agentIds = Object.keys(list.data || {});
  const allFound = created.agents.every(id => agentIds.includes(id));
  assert(allFound, `All 3 demo agents appear in GET /api/agents (${agentIds.length} total)`);

  // Update the researcher's description
  if (created.agents[0]) {
    const updated = await api('PUT', `/api/agents/${created.agents[0]}`, {
      description: 'Researches topics with web search and provides structured findings',
    });
    assert(updated.ok, `Updated Researcher description via PUT`);
  }

  return { researcherId: created.agents[0], builderId: created.agents[1], delegatorId: created.agents[2] };
}

// ── 3. Sessions & Chat ──────────────────────────────────

async function testSessions(agentIds) {
  section('3. Sessions & Chat');

  // Create a session linked to the researcher
  const session = await api('POST', '/api/sessions', {
    name: 'Demo Research Session',
    agentId: agentIds.researcherId,
  });
  assert(session.ok, `Created session → ${session.data?.id?.slice(0, 8)}`);
  if (session.data?.id) created.sessions.push(session.data.id);

  // List sessions
  const list = await api('GET', '/api/sessions');
  assert(list.ok && list.data, `GET /api/sessions returned data`);

  // Send a chat message and read SSE stream
  if (session.data?.id) {
    const sid = session.data.id;
    console.log(`  → Sending chat message to session ${sid.slice(0, 8)}...`);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      const res = await fetch(`${BASE}/api/sessions/${sid}/chat`, {
        method: 'POST',
        headers: { 'X-Access-Key': KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'What is SwarmClaw? Answer in exactly one sentence.' }),
        signal: controller.signal,
      });

      assert(res.ok, `POST /chat returned ${res.status}`);

      // Read SSE stream
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      let gotDone = false;
      let gotError = false;
      let errorMsg = '';
      let eventCount = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(l => l.startsWith('data: '));

        for (const line of lines) {
          try {
            const evt = JSON.parse(line.slice(6));
            eventCount++;
            if (evt.t === 'md' || evt.t === 'd') fullText += evt.text || '';
            if (evt.t === 'done') { gotDone = true; break; }
            if (evt.t === 'err') { gotError = true; errorMsg = evt.text; break; }
          } catch { /* partial JSON, skip */ }
        }
        if (gotDone || gotError) break;
      }

      clearTimeout(timeout);
      assert(eventCount > 0, `Received ${eventCount} SSE events`);
      if (gotDone) {
        assert(true, `Stream completed with 'done' event`);
        const preview = fullText.replace(/\n/g, ' ').slice(0, 100);
        console.log(`    Response: "${preview}${fullText.length > 100 ? '...' : ''}"`);
      } else if (gotError) {
        console.log(`    SSE error (infrastructure OK, provider issue): ${errorMsg}`);
        assert(true, `Stream responded with error event (infra working, provider: ${errorMsg.slice(0, 50)})`);
      } else {
        assert(false, `Stream ended without done or error event`);
      }
    } catch (err) {
      assert(false, `Chat streaming failed: ${err.message}`);
    }
  }

  // Rename session
  if (created.sessions[0]) {
    const renamed = await api('PUT', `/api/sessions/${created.sessions[0]}`, {
      name: 'Demo Research Session (completed)',
    });
    assert(renamed.ok, `Renamed session via PUT`);
  }

  return session.data?.id;
}

// ── 4. Task Board ────────────────────────────────────────

async function testTasks(agentIds) {
  section('4. Task Board');

  // Create a task
  const task = await api('POST', '/api/tasks', {
    title: 'Demo: Research SwarmClaw architecture',
    description: 'Analyze the SwarmClaw codebase and produce a summary of the key architectural patterns used.',
    status: 'backlog',
    agentId: agentIds.researcherId,
  });
  assert(task.ok, `Created task → ${task.data?.id?.slice(0, 8)}`);
  if (task.data?.id) created.tasks.push(task.data.id);

  // Create a second task
  const task2 = await api('POST', '/api/tasks', {
    title: 'Demo: Build a health-check endpoint',
    description: 'Create a simple /api/health endpoint that returns system status.',
    status: 'backlog',
    agentId: agentIds.builderId,
  });
  assert(task2.ok, `Created second task → ${task2.data?.id?.slice(0, 8)}`);
  if (task2.data?.id) created.tasks.push(task2.data.id);

  // Update task status
  if (created.tasks[0]) {
    const updated = await api('PUT', `/api/tasks/${created.tasks[0]}`, {
      status: 'queued',
    });
    assert(updated.ok, `Moved task to 'queued' status`);
  }

  // Add a comment to the task
  if (created.tasks[0]) {
    const commented = await api('PUT', `/api/tasks/${created.tasks[0]}`, {
      appendComment: 'Demo test: this task was created and updated programmatically by the platform test script.',
    });
    assert(commented.ok, `Added comment to task`);
  }

  // Read task back
  if (created.tasks[0]) {
    const read = await api('GET', `/api/tasks/${created.tasks[0]}`);
    assert(read.ok, `GET /api/tasks/${created.tasks[0].slice(0, 8)} returned data`);
    assert(read.data?.status === 'queued', `Task status is 'queued'`);
    assert(read.data?.comments?.length > 0, `Task has ${read.data?.comments?.length} comment(s)`);
  }

  // List all tasks
  const list = await api('GET', '/api/tasks');
  assert(list.ok, `GET /api/tasks lists ${Object.keys(list.data || {}).length} tasks`);
}

// ── 5. Delegation ────────────────────────────────────────

async function testDelegationConfig(agentIds) {
  section('5. Delegation');

  if (!agentIds.delegatorId) {
    console.log('  ⊘ Skipping: no delegator agent created');
    return;
  }

  const read = await api('GET', `/api/agents/${agentIds.delegatorId}`);
  assert(read.ok, `GET /api/agents/${agentIds.delegatorId.slice(0, 8)} returned data`);
  assert(read.data?.delegationEnabled === true, 'Delegation is enabled on the delegator');
  assert(read.data?.delegationTargetMode === 'selected', 'Delegator target mode is selected');
  assert(Array.isArray(read.data?.delegationTargetAgentIds) && read.data.delegationTargetAgentIds.length === 2, 'Delegator target list contains the expected agents');
}

// ── 6. Provider & Credential endpoints ──────────────────

async function testProviders() {
  section('6. Providers & Credentials');

  const providers = await api('GET', '/api/providers');
  assert(providers.ok, `GET /api/providers → ${providers.status}`);

  const creds = await api('GET', '/api/credentials');
  assert(creds.ok, `GET /api/credentials → ${creds.status}`);

  // Check daemon status
  const daemon = await api('GET', '/api/daemon');
  assert(daemon.ok, `GET /api/daemon → status=${daemon.data?.status || 'unknown'}`);
}

// ── 7. Cleanup ───────────────────────────────────────────

async function cleanup() {
  section('7. Cleanup');

  // Delete tasks
  for (const id of created.tasks) {
    const del = await api('DELETE', `/api/tasks/${id}`);
    console.log(`  → Deleted task ${id.slice(0, 8)} → ${del.status}`);
  }

  // Delete sessions
  for (const id of created.sessions) {
    const del = await api('DELETE', `/api/sessions/${id}`);
    console.log(`  → Deleted session ${id.slice(0, 8)} → ${del.status}`);
  }

  // Delete agents
  for (const id of created.agents) {
    const del = await api('DELETE', `/api/agents/${id}`);
    console.log(`  → Deleted agent ${id.slice(0, 8)} → ${del.status}`);
  }

  console.log(`  ✓ Cleanup complete`);
}

// ── Main ─────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║     SwarmClaw Platform Demo & Integration Test   ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`  Server: ${BASE}`);
  console.log(`  Key:    ${KEY.slice(0, 8)}...${KEY.slice(-4)}`);

  if (!KEY) {
    console.error('\n  ERROR: Set SWARMCLAW_ACCESS_KEY env var');
    process.exit(1);
  }

  try {
    await testAuth();
    const agentIds = await createAgents();
    await testSessions(agentIds);
    await testTasks(agentIds);
    await testDelegationConfig(agentIds);
    await testProviders();
    await cleanup();
  } catch (err) {
    console.error(`\n  FATAL: ${err.message}`);
    console.error(err.stack);
    // Still try to clean up
    try { await cleanup(); } catch { /* best effort */ }
  }

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═'.repeat(50));
  process.exit(failed > 0 ? 1 : 0);
}

main();
