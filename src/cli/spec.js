const COMMAND_GROUPS = {
  agents: {
    description: 'Manage agents',
    commands: {
      list: { description: 'List agents', method: 'GET', path: '/agents' },
      get: { description: 'Get an agent by id (from list)', virtualGet: true, collectionPath: '/agents', params: ['id'] },
      create: { description: 'Create an agent', method: 'POST', path: '/agents' },
      update: { description: 'Update an agent', method: 'PUT', path: '/agents/:id', params: ['id'] },
      delete: { description: 'Delete an agent', method: 'DELETE', path: '/agents/:id', params: ['id'] },
      trash: { description: 'List trashed agents', method: 'GET', path: '/agents/trash' },
      restore: { description: 'Restore a trashed agent', method: 'POST', path: '/agents/trash' },
      purge: { description: 'Permanently delete a trashed agent', method: 'DELETE', path: '/agents/trash' },
    },
  },
  activity: {
    description: 'Query activity feed events',
    commands: {
      list: { description: 'List activity events (supports --query limit=50,entityType=task,action=updated)', method: 'GET', path: '/activity' },
    },
  },
  auth: {
    description: 'Access-key auth checks',
    commands: {
      status: { description: 'Get auth setup status', method: 'GET', path: '/auth' },
      login: { description: 'Validate an access key', method: 'POST', path: '/auth' },
    },
  },
  chatrooms: {
    description: 'Manage multi-agent chatrooms',
    commands: {
      list: { description: 'List chatrooms', method: 'GET', path: '/chatrooms' },
      get: { description: 'Get chatroom by id', method: 'GET', path: '/chatrooms/:id', params: ['id'] },
      create: { description: 'Create a chatroom', method: 'POST', path: '/chatrooms' },
      update: { description: 'Update a chatroom', method: 'PUT', path: '/chatrooms/:id', params: ['id'] },
      delete: { description: 'Delete a chatroom', method: 'DELETE', path: '/chatrooms/:id', params: ['id'] },
      chat: { description: 'Post chatroom message and stream agent replies', method: 'POST', path: '/chatrooms/:id/chat', params: ['id'] },
      'add-member': { description: 'Add an agent to a chatroom', method: 'POST', path: '/chatrooms/:id/members', params: ['id'] },
      'remove-member': { description: 'Remove an agent from a chatroom', method: 'DELETE', path: '/chatrooms/:id/members', params: ['id'] },
      react: { description: 'Toggle reaction on a chatroom message', method: 'POST', path: '/chatrooms/:id/reactions', params: ['id'] },
      pin: { description: 'Toggle pin on a chatroom message', method: 'POST', path: '/chatrooms/:id/pins', params: ['id'] },
    },
  },
  canvas: {
    description: 'Session canvas content',
    commands: {
      get: { description: 'Get current canvas content for a session', method: 'GET', path: '/canvas/:sessionId', params: ['sessionId'] },
      set: { description: 'Set/clear canvas content for a session', method: 'POST', path: '/canvas/:sessionId', params: ['sessionId'] },
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
  uploads: {
    description: 'Manage uploaded artifacts',
    commands: {
      list: { description: 'List uploaded artifacts', method: 'GET', path: '/uploads' },
      get: { description: 'Download uploaded artifact by filename', method: 'GET', path: '/uploads/:filename', params: ['filename'], binary: true },
      delete: { description: 'Delete uploaded artifact by filename', method: 'DELETE', path: '/uploads/:filename', params: ['filename'] },
      'delete-many': { description: 'Delete uploads by filter/body (filenames, olderThanDays, category, or all)', method: 'DELETE', path: '/uploads' },
    },
  },
  files: {
    description: 'Serve/open local files',
    commands: {
      serve: { description: 'Serve a local file (supports --query path=/some/file)', method: 'GET', path: '/files/serve' },
      open: { description: 'Open a local file path via host default app/browser', method: 'POST', path: '/files/open' },
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
  notifications: {
    description: 'In-app notification center',
    commands: {
      list: { description: 'List notifications (supports --query unreadOnly=true,limit=100)', method: 'GET', path: '/notifications' },
      create: { description: 'Create notification', method: 'POST', path: '/notifications' },
      clear: { description: 'Clear read notifications', method: 'DELETE', path: '/notifications' },
      'mark-read': { description: 'Mark notification as read', method: 'PUT', path: '/notifications/:id', params: ['id'] },
      delete: { description: 'Delete notification by id', method: 'DELETE', path: '/notifications/:id', params: ['id'] },
    },
  },
  orchestrator: {
    description: 'Orchestrator runs and run-state APIs',
    commands: {
      run: { description: 'Run orchestrator task now', method: 'POST', path: '/orchestrator/run', waitable: true },
      runs: { description: 'List queued/running/completed runs', method: 'GET', path: '/runs' },
      'run-get': { description: 'Get run by id', method: 'GET', path: '/runs/:id', params: ['id'] },
      graph: { description: 'Get orchestrator graph structure', method: 'GET', path: '/orchestrator/graph' },
    },
  },
  openclaw: {
    description: 'OpenClaw discovery, gateway control, and runtime APIs',
    commands: {
      discover: { description: 'Discover OpenClaw gateways', method: 'GET', path: '/openclaw/discover' },
      directory: { description: 'List directory entries from running OpenClaw connectors', method: 'GET', path: '/openclaw/directory' },
      'gateway-status': { description: 'Check OpenClaw gateway connection status', method: 'GET', path: '/openclaw/gateway' },
      gateway: { description: 'Call OpenClaw gateway RPC/control action', method: 'POST', path: '/openclaw/gateway' },
      'config-sync': { description: 'Detect OpenClaw gateway config issues', method: 'GET', path: '/openclaw/config-sync' },
      'config-sync-repair': { description: 'Repair a detected OpenClaw config issue', method: 'POST', path: '/openclaw/config-sync' },
      approvals: { description: 'List pending OpenClaw execution approvals', method: 'GET', path: '/openclaw/approvals' },
      'approvals-resolve': { description: 'Resolve an OpenClaw execution approval', method: 'POST', path: '/openclaw/approvals' },
      cron: { description: 'List OpenClaw cron jobs', method: 'GET', path: '/openclaw/cron' },
      'cron-action': { description: 'Create/run/remove OpenClaw cron jobs', method: 'POST', path: '/openclaw/cron' },
      'agent-files': { description: 'Fetch OpenClaw agent files', method: 'GET', path: '/openclaw/agent-files' },
      'agent-files-set': { description: 'Save an OpenClaw agent file', method: 'PUT', path: '/openclaw/agent-files' },
      'dotenv-keys': { description: 'List gateway .env keys', method: 'GET', path: '/openclaw/dotenv-keys' },
      'exec-config': { description: 'Fetch OpenClaw exec approval config', method: 'GET', path: '/openclaw/exec-config' },
      'exec-config-set': { description: 'Save OpenClaw exec approval config', method: 'PUT', path: '/openclaw/exec-config' },
      'history-preview': { description: 'Preview OpenClaw session history', method: 'GET', path: '/openclaw/history' },
      'history-merge': { description: 'Merge OpenClaw session history into local session', method: 'POST', path: '/openclaw/history' },
      media: { description: 'Proxy OpenClaw media/file content', method: 'GET', path: '/openclaw/media' },
      models: { description: 'List allowed OpenClaw models', method: 'GET', path: '/openclaw/models' },
      permissions: { description: 'Get OpenClaw permission preset/config', method: 'GET', path: '/openclaw/permissions' },
      'permissions-set': { description: 'Apply OpenClaw permission preset', method: 'PUT', path: '/openclaw/permissions' },
      'sandbox-env': { description: 'List OpenClaw sandbox env allowlist', method: 'GET', path: '/openclaw/sandbox-env' },
      'sandbox-env-set': { description: 'Update OpenClaw sandbox env allowlist', method: 'PUT', path: '/openclaw/sandbox-env' },
      skills: { description: 'List OpenClaw skills and eligibility', method: 'GET', path: '/openclaw/skills' },
      'skills-update': { description: 'Update OpenClaw skill state/config', method: 'PATCH', path: '/openclaw/skills' },
      'skills-save': { description: 'Save OpenClaw skill allowlist mode/config', method: 'PUT', path: '/openclaw/skills' },
      'skills-install': { description: 'Install OpenClaw skill dependencies', method: 'POST', path: '/openclaw/skills/install' },
      'skills-remove': { description: 'Remove OpenClaw skill', method: 'POST', path: '/openclaw/skills/remove' },
      sync: { description: 'Run OpenClaw sync action', method: 'POST', path: '/openclaw/sync' },
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
  search: {
    description: 'Global search across app resources',
    commands: {
      query: { description: 'Search agents/tasks/chats/schedules/webhooks/skills (supports --query q=term)', method: 'GET', path: '/search' },
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
  chats: {
    description: 'Agent chats',
    commands: {
      list: { description: 'List chats', method: 'GET', path: '/chats' },
      create: { description: 'Create chat', method: 'POST', path: '/chats' },
      get: { description: 'Get chat by id (from list)', virtualGet: true, collectionPath: '/chats', params: ['id'] },
      update: { description: 'Update chat fields', method: 'PUT', path: '/chats/:id', params: ['id'] },
      delete: { description: 'Delete one chat', method: 'DELETE', path: '/chats/:id', params: ['id'] },
      'delete-many': { description: 'Delete multiple chats (body: {"ids":[...]})', method: 'DELETE', path: '/chats' },
      'heartbeat-disable-all': { description: 'Disable all chat heartbeats and cancel queued heartbeat runs', method: 'POST', path: '/chats/heartbeat' },
      messages: { description: 'Get chat message history', method: 'GET', path: '/chats/:id/messages', params: ['id'] },
      'messages-update': { description: 'Update chat message metadata (e.g. bookmark)', method: 'PUT', path: '/chats/:id/messages', params: ['id'] },
      'messages-send': { description: 'Append a user/system message to a chat', method: 'POST', path: '/chats/:id/messages', params: ['id'] },
      'messages-delete': { description: 'Delete a message from a chat', method: 'DELETE', path: '/chats/:id/messages', params: ['id'] },
      fork: { description: 'Fork chat from a specific message index', method: 'POST', path: '/chats/:id/fork', params: ['id'] },
      'edit-resend': { description: 'Edit and resend from a specific message index', method: 'POST', path: '/chats/:id/edit-resend', params: ['id'] },
      'main-loop': { description: 'Get main mission loop state for a chat', method: 'GET', path: '/chats/:id/main-loop', params: ['id'] },
      'main-loop-action': { description: 'Control main mission loop (pause/resume/set_goal/set_mode/clear_events/nudge)', method: 'POST', path: '/chats/:id/main-loop', params: ['id'] },
      chat: { description: 'Send chat message (SSE stream)', method: 'POST', path: '/chats/:id/chat', params: ['id'], stream: true, waitable: true },
      stop: { description: 'Cancel active/running chat work', method: 'POST', path: '/chats/:id/stop', params: ['id'] },
      clear: { description: 'Clear chat history', method: 'POST', path: '/chats/:id/clear', params: ['id'] },
      mailbox: { description: 'List mailbox envelopes for a chat', method: 'GET', path: '/chats/:id/mailbox', params: ['id'] },
      'mailbox-action': { description: 'Send/ack/clear mailbox envelopes', method: 'POST', path: '/chats/:id/mailbox', params: ['id'] },
      deploy: { description: 'Deploy chat workspace git changes', method: 'POST', path: '/chats/:id/deploy', params: ['id'] },
      devserver: { description: 'Start/stop/status dev server (body: {"action":"start|stop|status"})', method: 'POST', path: '/chats/:id/devserver', params: ['id'] },
      browser: { description: 'Check browser runtime for chat', method: 'GET', path: '/chats/:id/browser', params: ['id'] },
      'browser-clear': { description: 'Close browser runtime for chat', method: 'DELETE', path: '/chats/:id/browser', params: ['id'] },
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
      bulk: { description: 'Bulk update tasks (status/agent/project)', method: 'POST', path: '/tasks/bulk' },
      update: { description: 'Update task', method: 'PUT', path: '/tasks/:id', params: ['id'] },
      delete: { description: 'Archive task', method: 'DELETE', path: '/tasks/:id', params: ['id'] },
      archive: { description: 'Archive task', method: 'DELETE', path: '/tasks/:id', params: ['id'] },
      approve: { description: 'Approve or reject a pending tool execution', method: 'POST', path: '/tasks/:id/approve', params: ['id'] },
      metrics: { description: 'Get task board metrics (supports --query range=24h|7d|30d)', method: 'GET', path: '/tasks/metrics' },
    },
  },
  wallets: {
    description: 'Agent wallet operations',
    commands: {
      list: { description: 'List wallets', method: 'GET', path: '/wallets' },
      get: { description: 'Get wallet by id', method: 'GET', path: '/wallets/:id', params: ['id'] },
      create: { description: 'Create wallet', method: 'POST', path: '/wallets' },
      update: { description: 'Update wallet settings', method: 'PATCH', path: '/wallets/:id', params: ['id'] },
      delete: { description: 'Delete wallet', method: 'DELETE', path: '/wallets/:id', params: ['id'] },
      send: { description: 'Send funds from wallet', method: 'POST', path: '/wallets/:id/send', params: ['id'] },
      approve: { description: 'Approve or deny pending wallet transaction', method: 'POST', path: '/wallets/:id/approve', params: ['id'] },
      transactions: { description: 'List wallet transactions', method: 'GET', path: '/wallets/:id/transactions', params: ['id'] },
      'balance-history': { description: 'Get wallet balance history', method: 'GET', path: '/wallets/:id/balance-history', params: ['id'] },
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
