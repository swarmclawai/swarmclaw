const COMMAND_GROUPS = {
  agents: {
    description: 'Manage agents',
    commands: {
      list: { description: 'List agents', method: 'GET', path: '/agents' },
      get: { description: 'Get an agent by id (from list)', virtualGet: true, collectionPath: '/agents', params: ['id'] },
      create: { description: 'Create an agent', method: 'POST', path: '/agents' },
      update: { description: 'Update an agent', method: 'PUT', path: '/agents/:id', params: ['id'] },
      delete: { description: 'Delete an agent', method: 'DELETE', path: '/agents/:id', params: ['id'] },
    },
  },
  auth: {
    description: 'Access-key auth checks',
    commands: {
      status: { description: 'Get auth setup status', method: 'GET', path: '/auth' },
      login: { description: 'Validate an access key', method: 'POST', path: '/auth' },
    },
  },
  connectors: {
    description: 'Manage chat connectors',
    commands: {
      list: { description: 'List connectors', method: 'GET', path: '/connectors' },
      get: { description: 'Get connector details', method: 'GET', path: '/connectors/:id', params: ['id'] },
      create: { description: 'Create a connector', method: 'POST', path: '/connectors' },
      update: { description: 'Update connector config', method: 'PUT', path: '/connectors/:id', params: ['id'] },
      delete: { description: 'Delete connector', method: 'DELETE', path: '/connectors/:id', params: ['id'] },
      start: {
        description: 'Start connector runtime',
        method: 'PUT',
        path: '/connectors/:id',
        params: ['id'],
        staticBody: { action: 'start' },
      },
      stop: {
        description: 'Stop connector runtime',
        method: 'PUT',
        path: '/connectors/:id',
        params: ['id'],
        staticBody: { action: 'stop' },
      },
      repair: {
        description: 'Repair connector runtime',
        method: 'PUT',
        path: '/connectors/:id',
        params: ['id'],
        staticBody: { action: 'repair' },
      },
    },
  },
  credentials: {
    description: 'Manage encrypted provider credentials',
    commands: {
      list: { description: 'List credentials', method: 'GET', path: '/credentials' },
      get: { description: 'Get credential metadata by id (from list)', virtualGet: true, collectionPath: '/credentials', params: ['id'] },
      create: { description: 'Create credential', method: 'POST', path: '/credentials' },
      delete: { description: 'Delete credential', method: 'DELETE', path: '/credentials/:id', params: ['id'] },
    },
  },
  daemon: {
    description: 'Daemon lifecycle controls',
    commands: {
      status: { description: 'Get daemon status', method: 'GET', path: '/daemon' },
      start: { description: 'Start daemon', method: 'POST', path: '/daemon', staticBody: { action: 'start' } },
      stop: { description: 'Stop daemon', method: 'POST', path: '/daemon', staticBody: { action: 'stop' } },
      'health-check': { description: 'Run daemon health checks immediately', method: 'POST', path: '/daemon/health-check' },
    },
  },
  dirs: {
    description: 'Directory browsing helpers',
    commands: {
      list: { description: 'List directories (supports --query path=/some/dir)', method: 'GET', path: '/dirs' },
      pick: { description: 'Open native picker (body: {"mode":"file|folder"})', method: 'POST', path: '/dirs/pick' },
    },
  },
  documents: {
    description: 'File uploads/downloads and TTS audio',
    commands: {
      upload: {
        description: 'Upload a file (requires --file)',
        method: 'POST',
        path: '/upload',
        upload: true,
      },
      fetch: {
        description: 'Download an uploaded file by filename',
        method: 'GET',
        path: '/uploads/:filename',
        params: ['filename'],
        binary: true,
      },
      tts: {
        description: 'Generate TTS audio (body: {"text":"..."})',
        method: 'POST',
        path: '/tts',
        binary: true,
      },
    },
  },
  logs: {
    description: 'Application logs',
    commands: {
      list: { description: 'Fetch logs (supports --query lines=200,level=INFO)', method: 'GET', path: '/logs' },
      clear: { description: 'Clear log file', method: 'DELETE', path: '/logs' },
    },
  },
  memory: {
    description: 'Agent memory entries',
    commands: {
      list: { description: 'List memory entries (supports --query q=term,agentId=id)', method: 'GET', path: '/memory' },
      get: { description: 'Get memory entry by id', method: 'GET', path: '/memory/:id', params: ['id'] },
      create: { description: 'Create memory entry', method: 'POST', path: '/memory' },
      update: { description: 'Update memory entry', method: 'PUT', path: '/memory/:id', params: ['id'] },
      delete: { description: 'Delete memory entry', method: 'DELETE', path: '/memory/:id', params: ['id'] },
      maintenance: { description: 'Analyze memory dedupe/prune candidates', method: 'GET', path: '/memory/maintenance' },
      'maintenance-run': { description: 'Run memory dedupe/prune maintenance', method: 'POST', path: '/memory/maintenance' },
    },
  },
  'memory-images': {
    description: 'Stored memory image assets',
    commands: {
      get: { description: 'Download memory image by filename', method: 'GET', path: '/memory-images/:filename', params: ['filename'], binary: true },
    },
  },
  orchestrator: {
    description: 'Orchestrator runs and run-state APIs',
    commands: {
      run: { description: 'Run orchestrator task now', method: 'POST', path: '/orchestrator/run', waitable: true },
      runs: { description: 'List queued/running/completed runs', method: 'GET', path: '/runs' },
      'run-get': { description: 'Get run by id', method: 'GET', path: '/runs/:id', params: ['id'] },
    },
  },
  plugins: {
    description: 'Plugin listing/config/install',
    commands: {
      list: { description: 'List installed plugins', method: 'GET', path: '/plugins' },
      update: { description: 'Enable/disable plugin (body: {"filename":"x.js","enabled":true})', method: 'POST', path: '/plugins' },
      marketplace: { description: 'Get plugin marketplace registry', method: 'GET', path: '/plugins/marketplace' },
      install: { description: 'Install plugin by URL', method: 'POST', path: '/plugins/install' },
    },
  },
  providers: {
    description: 'Provider configs and model overrides',
    commands: {
      list: { description: 'List providers', method: 'GET', path: '/providers' },
      create: { description: 'Create custom provider', method: 'POST', path: '/providers' },
      get: { description: 'Get provider by id', method: 'GET', path: '/providers/:id', params: ['id'] },
      update: { description: 'Update provider config', method: 'PUT', path: '/providers/:id', params: ['id'] },
      delete: { description: 'Delete custom provider', method: 'DELETE', path: '/providers/:id', params: ['id'] },
      configs: { description: 'List provider configs only', method: 'GET', path: '/providers/configs' },
      ollama: { description: 'List local Ollama models', method: 'GET', path: '/providers/ollama' },
      'openclaw-health': { description: 'Probe OpenClaw endpoint and auth status', method: 'GET', path: '/providers/openclaw/health' },
      'models-get': { description: 'Get provider model overrides', method: 'GET', path: '/providers/:id/models', params: ['id'] },
      'models-set': { description: 'Set provider model overrides', method: 'PUT', path: '/providers/:id/models', params: ['id'] },
      'models-reset': { description: 'Delete provider model overrides', method: 'DELETE', path: '/providers/:id/models', params: ['id'] },
    },
  },
  schedules: {
    description: 'Scheduled task automation',
    commands: {
      list: { description: 'List schedules', method: 'GET', path: '/schedules' },
      create: { description: 'Create schedule', method: 'POST', path: '/schedules' },
      get: { description: 'Get schedule by id (from list)', virtualGet: true, collectionPath: '/schedules', params: ['id'] },
      update: { description: 'Update schedule', method: 'PUT', path: '/schedules/:id', params: ['id'] },
      delete: { description: 'Delete schedule', method: 'DELETE', path: '/schedules/:id', params: ['id'] },
      run: { description: 'Trigger schedule immediately', method: 'POST', path: '/schedules/:id/run', params: ['id'] },
    },
  },
  secrets: {
    description: 'Encrypted secret vault',
    commands: {
      list: { description: 'List secret metadata', method: 'GET', path: '/secrets' },
      get: { description: 'Get secret metadata by id (from list)', virtualGet: true, collectionPath: '/secrets', params: ['id'] },
      create: { description: 'Create secret', method: 'POST', path: '/secrets' },
      update: { description: 'Update secret metadata', method: 'PUT', path: '/secrets/:id', params: ['id'] },
      delete: { description: 'Delete secret', method: 'DELETE', path: '/secrets/:id', params: ['id'] },
    },
  },
  sessions: {
    description: 'Interactive chat sessions',
    commands: {
      list: { description: 'List sessions', method: 'GET', path: '/sessions' },
      create: { description: 'Create session', method: 'POST', path: '/sessions' },
      get: { description: 'Get session by id (from list)', virtualGet: true, collectionPath: '/sessions', params: ['id'] },
      update: { description: 'Update session fields', method: 'PUT', path: '/sessions/:id', params: ['id'] },
      delete: { description: 'Delete one session', method: 'DELETE', path: '/sessions/:id', params: ['id'] },
      'delete-many': { description: 'Delete multiple sessions (body: {"ids":[...]})', method: 'DELETE', path: '/sessions' },
      'heartbeat-disable-all': { description: 'Disable all session heartbeats and cancel queued heartbeat runs', method: 'POST', path: '/sessions/heartbeat' },
      messages: { description: 'Get session message history', method: 'GET', path: '/sessions/:id/messages', params: ['id'] },
      'main-loop': { description: 'Get main mission loop state for a session', method: 'GET', path: '/sessions/:id/main-loop', params: ['id'] },
      'main-loop-action': { description: 'Control main mission loop (pause/resume/set_goal/set_mode/clear_events/nudge)', method: 'POST', path: '/sessions/:id/main-loop', params: ['id'] },
      chat: { description: 'Send chat message (SSE stream)', method: 'POST', path: '/sessions/:id/chat', params: ['id'], stream: true, waitable: true },
      stop: { description: 'Cancel active/running session work', method: 'POST', path: '/sessions/:id/stop', params: ['id'] },
      clear: { description: 'Clear session history', method: 'POST', path: '/sessions/:id/clear', params: ['id'] },
      mailbox: { description: 'List mailbox envelopes for a session', method: 'GET', path: '/sessions/:id/mailbox', params: ['id'] },
      'mailbox-action': { description: 'Send/ack/clear mailbox envelopes', method: 'POST', path: '/sessions/:id/mailbox', params: ['id'] },
      deploy: { description: 'Deploy session workspace git changes', method: 'POST', path: '/sessions/:id/deploy', params: ['id'] },
      devserver: { description: 'Start/stop/status dev server (body: {"action":"start|stop|status"})', method: 'POST', path: '/sessions/:id/devserver', params: ['id'] },
      browser: { description: 'Check browser runtime for session', method: 'GET', path: '/sessions/:id/browser', params: ['id'] },
      'browser-clear': { description: 'Close browser runtime for session', method: 'DELETE', path: '/sessions/:id/browser', params: ['id'] },
    },
  },
  settings: {
    description: 'Global app settings',
    commands: {
      get: { description: 'Get settings', method: 'GET', path: '/settings' },
      update: { description: 'Update settings', method: 'PUT', path: '/settings' },
    },
  },
  setup: {
    description: 'Setup and provider validation helpers',
    commands: {
      'check-provider': { description: 'Validate provider credentials/endpoint', method: 'POST', path: '/setup/check-provider' },
      doctor: { description: 'Run local setup diagnostics', method: 'GET', path: '/setup/doctor' },
    },
  },
  skills: {
    description: 'SwarmClaw and Claude skills',
    commands: {
      list: { description: 'List SwarmClaw skills', method: 'GET', path: '/skills' },
      get: { description: 'Get SwarmClaw skill by id', method: 'GET', path: '/skills/:id', params: ['id'] },
      create: { description: 'Create SwarmClaw skill', method: 'POST', path: '/skills' },
      update: { description: 'Update SwarmClaw skill', method: 'PUT', path: '/skills/:id', params: ['id'] },
      delete: { description: 'Delete SwarmClaw skill', method: 'DELETE', path: '/skills/:id', params: ['id'] },
      import: { description: 'Import skill from URL', method: 'POST', path: '/skills/import' },
      claude: { description: 'List local ~/.claude/skills', method: 'GET', path: '/claude-skills' },
    },
  },
  system: {
    description: 'System and version endpoints',
    commands: {
      ip: { description: 'Get local bind IP/port', method: 'GET', path: '/ip' },
      usage: { description: 'Get usage summary', method: 'GET', path: '/usage' },
      version: { description: 'Get local/remote git version info', method: 'GET', path: '/version' },
      update: { description: 'Update to latest stable release tag (fallback: main)', method: 'POST', path: '/version/update' },
    },
  },
  tasks: {
    description: 'Task board operations',
    commands: {
      list: { description: 'List tasks', method: 'GET', path: '/tasks' },
      get: { description: 'Get task by id', method: 'GET', path: '/tasks/:id', params: ['id'] },
      create: { description: 'Create task', method: 'POST', path: '/tasks' },
      update: { description: 'Update task', method: 'PUT', path: '/tasks/:id', params: ['id'] },
      delete: { description: 'Archive task', method: 'DELETE', path: '/tasks/:id', params: ['id'] },
      archive: { description: 'Archive task', method: 'DELETE', path: '/tasks/:id', params: ['id'] },
    },
  },
  webhooks: {
    description: 'Inbound webhook triggers',
    commands: {
      trigger: { description: 'Trigger webhook by id', method: 'POST', path: '/webhooks/:id', params: ['id'], waitable: true },
    },
  },
}

const GROUP_NAMES = Object.keys(COMMAND_GROUPS)

function listCoveredRoutes() {
  const routes = []
  for (const group of GROUP_NAMES) {
    const commands = COMMAND_GROUPS[group].commands
    for (const action of Object.keys(commands)) {
      const cmd = commands[action]
      if (cmd.method && cmd.path) {
        routes.push(`${cmd.method.toUpperCase()} ${cmd.path}`)
      }
    }
  }
  return routes
}

module.exports = {
  COMMAND_GROUPS,
  GROUP_NAMES,
  listCoveredRoutes,
}
