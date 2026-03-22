'use strict'

/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require('fs')
const path = require('path')

function cmd(action, method, route, description, extra = {}) {
  return { action, method, route, description, ...extra }
}

const COMMAND_GROUPS = [
  {
    name: 'agents',
    description: 'Manage agents',
    commands: [
      cmd('list', 'GET', '/agents', 'List agents'),
      cmd('get', 'GET', '/agents/:id', 'Get an agent by id', { virtual: true, clientGetRoute: '/agents' }),
      cmd('create', 'POST', '/agents', 'Create an agent', { expectsJsonBody: true }),
      cmd('update', 'PUT', '/agents/:id', 'Update an agent', { expectsJsonBody: true }),
      cmd('delete', 'DELETE', '/agents/:id', 'Delete an agent'),
      cmd('trash', 'GET', '/agents/trash', 'List trashed agents'),
      cmd('restore', 'POST', '/agents/trash', 'Restore a trashed agent', { expectsJsonBody: true }),
      cmd('purge', 'DELETE', '/agents/trash', 'Permanently delete a trashed agent', { expectsJsonBody: true }),
      cmd('thread', 'POST', '/agents/:id/thread', 'Get or create agent thread session'),
      cmd('clone', 'POST', '/agents/:id/clone', 'Clone an agent'),
      cmd('bulk-update', 'PATCH', '/agents/bulk', 'Bulk update agents', { expectsJsonBody: true }),
      cmd('status', 'GET', '/agents/:id/status', 'Get live status for an agent'),
    ],
  },
  {
    name: 'activity',
    description: 'Query activity feed events',
    commands: [
      cmd('list', 'GET', '/activity', 'List activity events (use --query limit=50, --query entityType=task, --query action=updated)'),
    ],
  },
  {
    name: 'auth',
    description: 'Access key auth helpers',
    commands: [
      cmd('status', 'GET', '/auth', 'Check auth setup status'),
      cmd('login', 'POST', '/auth', 'Validate an access key', {
        expectsJsonBody: true,
        bodyFlagMap: { key: 'key' },
      }),
    ],
  },
  {
    name: 'autonomy',
    description: 'Inspect supervisor incidents and reflection output',
    commands: [
      cmd('incidents', 'GET', '/autonomy/incidents', 'List supervisor incidents (use --query sessionId=..., --query taskId=..., --query limit=50)'),
      cmd('reflections', 'GET', '/autonomy/reflections', 'List run reflections (use --query sessionId=..., --query taskId=..., --query limit=50)'),
      cmd('estop', 'GET', '/autonomy/estop', 'Get autonomy emergency-stop state'),
      cmd('estop-set', 'POST', '/autonomy/estop', 'Engage or resume autonomy emergency-stop state', { expectsJsonBody: true }),
      cmd('guardian-restore', 'POST', '/autonomy/guardian/restore', 'Restore the latest guardian checkpoint after approval', { expectsJsonBody: true }),
    ],
  },
  {
    name: 'approvals',
    description: 'List and resolve human-loop approvals',
    commands: [
      cmd('list', 'GET', '/approvals', 'List pending human-loop approvals'),
      cmd('resolve', 'POST', '/approvals', 'Resolve a human-loop approval', { expectsJsonBody: true }),
    ],
  },
  {
    name: 'claude-skills',
    description: 'Read local Claude skills directory metadata',
    commands: [
      cmd('list', 'GET', '/claude-skills', 'List Claude skills discovered on host'),
    ],
  },
  {
    name: 'clawhub',
    description: 'Browse and install ClawHub skills',
    commands: [
      cmd('search', 'GET', '/clawhub/search', 'Search ClawHub skills catalog'),
      cmd('preview', 'POST', '/clawhub/preview', 'Preview a ClawHub skill install without writing files', { expectsJsonBody: true }),
      cmd('install', 'POST', '/clawhub/install', 'Install a skill from ClawHub', { expectsJsonBody: true }),
    ],
  },
  {
    name: 'chatrooms',
    description: 'Manage multi-agent chatrooms',
    commands: [
      cmd('list', 'GET', '/chatrooms', 'List chatrooms'),
      cmd('get', 'GET', '/chatrooms/:id', 'Get chatroom by id'),
      cmd('create', 'POST', '/chatrooms', 'Create a chatroom', { expectsJsonBody: true }),
      cmd('update', 'PUT', '/chatrooms/:id', 'Update a chatroom', { expectsJsonBody: true }),
      cmd('delete', 'DELETE', '/chatrooms/:id', 'Delete a chatroom'),
      cmd('chat', 'POST', '/chatrooms/:id/chat', 'Post a message to a chatroom and stream agent replies', {
        expectsJsonBody: true,
        responseType: 'sse',
      }),
      cmd('add-member', 'POST', '/chatrooms/:id/members', 'Add an agent to a chatroom (use --data \'{"agentId":"..."}\')', { expectsJsonBody: true }),
      cmd('remove-member', 'DELETE', '/chatrooms/:id/members', 'Remove an agent from a chatroom (use --data \'{"agentId":"..."}\')', { expectsJsonBody: true }),
      cmd('react', 'POST', '/chatrooms/:id/reactions', 'Toggle a reaction on a chatroom message', {
        expectsJsonBody: true,
      }),
      cmd('pin', 'POST', '/chatrooms/:id/pins', 'Toggle pin on a chatroom message', {
        expectsJsonBody: true,
      }),
      cmd('moderate', 'POST', '/chatrooms/:id/moderate', 'Run moderation action on a chatroom', { expectsJsonBody: true }),
    ],
  },
  {
    name: 'canvas',
    description: 'Read/update per-session canvas content',
    commands: [
      cmd('get', 'GET', '/canvas/:sessionId', 'Get current canvas content for a session'),
      cmd('set', 'POST', '/canvas/:sessionId', 'Set/clear canvas content for a session', { expectsJsonBody: true }),
    ],
  },
  {
    name: 'connectors',
    description: 'Manage chat connectors',
    commands: [
      cmd('list', 'GET', '/connectors', 'List connectors'),
      cmd('get', 'GET', '/connectors/:id', 'Get connector'),
      cmd('create', 'POST', '/connectors', 'Create connector', { expectsJsonBody: true }),
      cmd('update', 'PUT', '/connectors/:id', 'Update connector', { expectsJsonBody: true }),
      cmd('delete', 'DELETE', '/connectors/:id', 'Delete connector'),
      cmd('webhook', 'POST', '/connectors/:id/webhook', 'Trigger connector webhook ingress', { expectsJsonBody: true }),
      cmd('start', 'PUT', '/connectors/:id', 'Start connector', {
        expectsJsonBody: true,
        defaultBody: { action: 'start' },
      }),
      cmd('stop', 'PUT', '/connectors/:id', 'Stop connector', {
        expectsJsonBody: true,
        defaultBody: { action: 'stop' },
      }),
      cmd('repair', 'PUT', '/connectors/:id', 'Repair connector', {
        expectsJsonBody: true,
        defaultBody: { action: 'repair' },
      }),
      cmd('health', 'GET', '/connectors/:id/health', 'Get connector health status'),
      cmd('access-get', 'GET', '/connectors/:id/access', 'Get connector access and ownership state'),
      cmd('access-set', 'PUT', '/connectors/:id/access', 'Update connector access and ownership state', { expectsJsonBody: true }),
      cmd('doctor', 'GET', '/connectors/:id/doctor', 'Get connector doctor diagnostics'),
      cmd('doctor-preview', 'POST', '/connectors/:id/doctor', 'Preview connector doctor diagnostics with temporary overrides', { expectsJsonBody: true }),
      cmd('doctor-draft', 'POST', '/connectors/doctor', 'Preview connector doctor diagnostics before saving a connector', { expectsJsonBody: true }),
    ],
  },
  {
    name: 'credentials',
    description: 'Manage encrypted provider credentials',
    commands: [
      cmd('list', 'GET', '/credentials', 'List credentials'),
      cmd('get', 'GET', '/credentials/:id', 'Get credential metadata by id', { virtual: true, clientGetRoute: '/credentials' }),
      cmd('create', 'POST', '/credentials', 'Create credential', { expectsJsonBody: true }),
      cmd('delete', 'DELETE', '/credentials/:id', 'Delete credential'),
    ],
  },
  {
    name: 'daemon',
    description: 'Control background daemon',
    commands: [
      cmd('status', 'GET', '/daemon', 'Get daemon status'),
      cmd('action', 'POST', '/daemon', 'Set daemon action via JSON body', { expectsJsonBody: true }),
      cmd('start', 'POST', '/daemon', 'Start daemon', {
        expectsJsonBody: true,
        defaultBody: { action: 'start' },
      }),
      cmd('stop', 'POST', '/daemon', 'Stop daemon', {
        expectsJsonBody: true,
        defaultBody: { action: 'stop' },
      }),
      cmd('health-check', 'POST', '/daemon/health-check', 'Run daemon health checks immediately'),
    ],
  },
  {
    name: 'delegation-jobs',
    description: 'Delegation job status',
    commands: [
      cmd('list', 'GET', '/delegation-jobs', 'List active and recent delegation jobs'),
    ],
  },
  {
    name: 'dirs',
    description: 'Directory listing and native picker',
    commands: [
      cmd('list', 'GET', '/dirs', 'List directories (use --query path=/abs/path)'),
      cmd('pick', 'POST', '/dirs/pick', 'Open native picker (mode=file|folder)', { expectsJsonBody: true }),
    ],
  },
  {
    name: 'perf',
    description: 'Inspect or control runtime perf tracing',
    commands: [
      cmd('status', 'GET', '/perf', 'Get current perf tracing status and recent entries'),
      cmd('enable', 'POST', '/perf', 'Enable perf tracing and clear existing entries', {
        expectsJsonBody: true,
        defaultBody: { action: 'enable' },
      }),
      cmd('disable', 'POST', '/perf', 'Disable perf tracing', {
        expectsJsonBody: true,
        defaultBody: { action: 'disable' },
      }),
      cmd('clear', 'POST', '/perf', 'Clear recent perf entries', {
        expectsJsonBody: true,
        defaultBody: { action: 'clear' },
      }),
    ],
  },
  {
    name: 'documents',
    description: 'Manage documents',
    commands: [
      cmd('list', 'GET', '/documents', 'List documents'),
      cmd('get', 'GET', '/documents/:id', 'Get document by id'),
      cmd('create', 'POST', '/documents', 'Create document', { expectsJsonBody: true }),
      cmd('update', 'PUT', '/documents/:id', 'Update document', { expectsJsonBody: true }),
      cmd('delete', 'DELETE', '/documents/:id', 'Delete document'),
      cmd('revisions', 'GET', '/documents/:id/revisions', 'List document revisions'),
    ],
  },
  {
    name: 'eval',
    description: 'Run agent evaluation scenarios',
    commands: [
      cmd('scenarios', 'GET', '/eval/scenarios', 'List available eval scenarios'),
      cmd('status', 'GET', '/eval/run', 'Get eval run status'),
      cmd('run', 'POST', '/eval/run', 'Run an eval scenario against an agent', { expectsJsonBody: true }),
      cmd('suite', 'POST', '/eval/suite', 'Run a full eval suite against an agent', { expectsJsonBody: true }),
    ],
  },
  {
    name: 'external-agents',
    description: 'Manage external agent runtimes',
    commands: [
      cmd('list', 'GET', '/external-agents', 'List external agent runtimes'),
      cmd('create', 'POST', '/external-agents', 'Register an external agent runtime', { expectsJsonBody: true }),
      cmd('update', 'PUT', '/external-agents/:id', 'Update an external agent runtime', { expectsJsonBody: true }),
      cmd('delete', 'DELETE', '/external-agents/:id', 'Delete an external agent runtime'),
      cmd('heartbeat', 'POST', '/external-agents/:id/heartbeat', 'Record an external agent heartbeat', { expectsJsonBody: true }),
    ],
  },
  {
    name: 'files',
    description: 'Serve and manage local files',
    commands: [
      cmd('serve', 'GET', '/files/serve', 'Serve a local file (use --query path=/abs/path)'),
      cmd('open', 'POST', '/files/open', 'Open a local file path via the host default app/browser', { expectsJsonBody: true }),
    ],
  },
  {
    name: 'gateways',
    description: 'Manage named OpenClaw gateway profiles',
    commands: [
      cmd('list', 'GET', '/gateways', 'List configured gateway profiles'),
      cmd('create', 'POST', '/gateways', 'Create a gateway profile', { expectsJsonBody: true }),
      cmd('update', 'PUT', '/gateways/:id', 'Update a gateway profile', { expectsJsonBody: true }),
      cmd('delete', 'DELETE', '/gateways/:id', 'Delete a gateway profile'),
      cmd('health', 'GET', '/gateways/:id/health', 'Run a gateway health check'),
    ],
  },
  {
    name: 'ip',
    description: 'Get local IP/port metadata',
    commands: [
      cmd('get', 'GET', '/ip', 'Get host IP and port'),
    ],
  },
  {
    name: 'knowledge',
    description: 'Manage knowledge base entries',
    commands: [
      cmd('list', 'GET', '/knowledge', 'List knowledge entries'),
      cmd('get', 'GET', '/knowledge/:id', 'Get knowledge entry by id'),
      cmd('create', 'POST', '/knowledge', 'Create knowledge entry', { expectsJsonBody: true }),
      cmd('update', 'PUT', '/knowledge/:id', 'Update knowledge entry', { expectsJsonBody: true }),
      cmd('delete', 'DELETE', '/knowledge/:id', 'Delete knowledge entry'),
      cmd('upload', 'POST', '/knowledge/upload', 'Upload document for knowledge extraction', {
        requestType: 'upload',
        inputPositional: 'filePath',
      }),
    ],
  },
  {
    name: 'logs',
    description: 'Read or clear app logs',
    commands: [
      cmd('list', 'GET', '/logs', 'List logs (use --query lines=200, --query level=INFO,ERROR)'),
      cmd('clear', 'DELETE', '/logs', 'Clear logs file'),
    ],
  },
  {
    name: 'memory',
    description: 'Manage memory entries',
    commands: [
      cmd('list', 'GET', '/memory', 'List memory entries (use --query q=, --query agentId=)'),
      cmd('get', 'GET', '/memory/:id', 'Get memory by id'),
      cmd('create', 'POST', '/memory', 'Create memory entry', { expectsJsonBody: true }),
      cmd('update', 'PUT', '/memory/:id', 'Update memory entry', { expectsJsonBody: true }),
      cmd('delete', 'DELETE', '/memory/:id', 'Delete memory entry'),
      cmd('maintenance', 'GET', '/memory/maintenance', 'Analyze memory dedupe/prune candidates'),
      cmd('maintenance-run', 'POST', '/memory/maintenance', 'Run memory dedupe/prune maintenance', { expectsJsonBody: true }),
      cmd('graph', 'GET', '/memory/graph', 'Get memory graph (nodes and links) for visualization'),
    ],
  },
  {
    name: 'memory-images',
    description: 'Fetch stored memory image assets',
    commands: [
      cmd('get', 'GET', '/memory-images/:filename', 'Download memory image by filename', { responseType: 'binary' }),
    ],
  },
  {
    name: 'missions',
    description: 'Inspect and control durable missions',
    commands: [
      cmd('list', 'GET', '/missions', 'List missions (use --query status=, --query phase=, --query source=, --query sessionId=, --query agentId=, --query projectId=)'),
      cmd('get', 'GET', '/missions/:id', 'Get mission detail by id'),
      cmd('events', 'GET', '/missions/:id/events', 'Get mission event timeline', { expectsQueryHint: true }),
      cmd('action', 'POST', '/missions/:id/actions', 'Run a mission control action (resume, replan, retry_verification, wait, cancel)', { expectsJsonBody: true }),
    ],
  },
  {
    name: 'notifications',
    description: 'Manage in-app notifications',
    commands: [
      cmd('list', 'GET', '/notifications', 'List notifications (use --query unreadOnly=true --query limit=100)'),
      cmd('create', 'POST', '/notifications', 'Create notification', { expectsJsonBody: true }),
      cmd('clear', 'DELETE', '/notifications', 'Clear read notifications'),
      cmd('mark-read', 'PUT', '/notifications/:id', 'Mark notification as read'),
      cmd('delete', 'DELETE', '/notifications/:id', 'Delete notification by id'),
    ],
  },
  {
    name: 'protocols',
    description: 'Manage Structured Session runs and templates',
    commands: [
      cmd('list', 'GET', '/protocols/runs', 'List structured session runs'),
      cmd('get', 'GET', '/protocols/runs/:id', 'Get structured session run detail'),
      cmd('events', 'GET', '/protocols/runs/:id/events', 'Get structured session run events'),
      cmd('create', 'POST', '/protocols/runs', 'Create a structured session run', { expectsJsonBody: true }),
      cmd('action', 'POST', '/protocols/runs/:id/actions', 'Run a structured session action', { expectsJsonBody: true }),
      cmd('templates', 'GET', '/protocols/templates', 'List structured session templates'),
      cmd('template-get', 'GET', '/protocols/templates/:id', 'Get structured session template detail'),
      cmd('template-create', 'POST', '/protocols/templates', 'Create a structured session template', { expectsJsonBody: true }),
      cmd('template-update', 'PATCH', '/protocols/templates/:id', 'Update a structured session template', { expectsJsonBody: true }),
      cmd('template-delete', 'DELETE', '/protocols/templates/:id', 'Delete a structured session template'),
    ],
  },
  {
    name: 'mcp-servers',
    description: 'Manage MCP server configurations',
    commands: [
      cmd('list', 'GET', '/mcp-servers', 'List MCP servers'),
      cmd('get', 'GET', '/mcp-servers/:id', 'Get MCP server by id'),
      cmd('create', 'POST', '/mcp-servers', 'Create MCP server', { expectsJsonBody: true }),
      cmd('update', 'PUT', '/mcp-servers/:id', 'Update MCP server', { expectsJsonBody: true }),
      cmd('delete', 'DELETE', '/mcp-servers/:id', 'Delete MCP server'),
      cmd('test', 'POST', '/mcp-servers/:id/test', 'Test MCP server connection'),
      cmd('tools', 'GET', '/mcp-servers/:id/tools', 'List tools available on an MCP server'),
      cmd('conformance', 'POST', '/mcp-servers/:id/conformance', 'Run MCP conformance checks for a server', { expectsJsonBody: true }),
      cmd('invoke', 'POST', '/mcp-servers/:id/invoke', 'Invoke an MCP tool on a server', { expectsJsonBody: true }),
    ],
  },
  {
    name: 'memories',
    description: 'Alias of memory command group',
    aliasFor: 'memory',
    commands: [],
  },
  {
    name: 'openclaw',
    description: 'OpenClaw discovery, gateway control, and runtime APIs',
    commands: [
      cmd('discover', 'GET', '/openclaw/discover', 'Discover OpenClaw gateways'),
      cmd('deploy-status', 'GET', '/openclaw/deploy', 'Get managed OpenClaw deploy status'),
      cmd('deploy-local-start', 'POST', '/openclaw/deploy', 'Start a managed local OpenClaw deployment (use --data JSON for port/token overrides)', {
        expectsJsonBody: true,
        defaultBody: { action: 'start-local' },
      }),
      cmd('deploy-local-stop', 'POST', '/openclaw/deploy', 'Stop the managed local OpenClaw deployment', {
        expectsJsonBody: true,
        defaultBody: { action: 'stop-local' },
      }),
      cmd('deploy-local-restart', 'POST', '/openclaw/deploy', 'Restart the managed local OpenClaw deployment (use --data JSON for port/token overrides)', {
        expectsJsonBody: true,
        defaultBody: { action: 'restart-local' },
      }),
      cmd('deploy-bundle', 'POST', '/openclaw/deploy', 'Generate an OpenClaw remote deployment bundle (use --data JSON for template/target/token)', {
        expectsJsonBody: true,
        defaultBody: { action: 'bundle' },
      }),
      cmd('deploy-ssh', 'POST', '/openclaw/deploy', 'Push the official-image OpenClaw bundle to a remote host over SSH (use --data JSON for target/ssh/provider)', {
        expectsJsonBody: true,
        defaultBody: { action: 'ssh-deploy' },
      }),
      cmd('deploy-verify', 'POST', '/openclaw/deploy', 'Verify an OpenClaw endpoint/token pair (use --data JSON for endpoint/token)', {
        expectsJsonBody: true,
        defaultBody: { action: 'verify' },
      }),
      cmd('remote-start', 'POST', '/openclaw/deploy', 'Start a remote SSH-managed OpenClaw stack', {
        expectsJsonBody: true,
        defaultBody: { action: 'remote-start' },
      }),
      cmd('remote-stop', 'POST', '/openclaw/deploy', 'Stop a remote SSH-managed OpenClaw stack', {
        expectsJsonBody: true,
        defaultBody: { action: 'remote-stop' },
      }),
      cmd('remote-restart', 'POST', '/openclaw/deploy', 'Restart a remote SSH-managed OpenClaw stack', {
        expectsJsonBody: true,
        defaultBody: { action: 'remote-restart' },
      }),
      cmd('remote-upgrade', 'POST', '/openclaw/deploy', 'Upgrade a remote SSH-managed OpenClaw stack', {
        expectsJsonBody: true,
        defaultBody: { action: 'remote-upgrade' },
      }),
      cmd('remote-backup', 'POST', '/openclaw/deploy', 'Create a remote backup on an SSH-managed OpenClaw host', {
        expectsJsonBody: true,
        defaultBody: { action: 'remote-backup' },
      }),
      cmd('remote-restore', 'POST', '/openclaw/deploy', 'Restore a remote backup on an SSH-managed OpenClaw host', {
        expectsJsonBody: true,
        defaultBody: { action: 'remote-restore' },
      }),
      cmd('remote-rotate-token', 'POST', '/openclaw/deploy', 'Rotate the gateway token on an SSH-managed OpenClaw host', {
        expectsJsonBody: true,
        defaultBody: { action: 'remote-rotate-token' },
      }),
      cmd('directory', 'GET', '/openclaw/directory', 'List directory entries from running OpenClaw connectors'),
      cmd('gateway-status', 'GET', '/openclaw/gateway', 'Check OpenClaw gateway connection status'),
      cmd('gateway', 'POST', '/openclaw/gateway', 'Call OpenClaw gateway RPC/control action', { expectsJsonBody: true }),
      cmd('config-sync', 'GET', '/openclaw/config-sync', 'Detect OpenClaw gateway config issues'),
      cmd('config-sync-repair', 'POST', '/openclaw/config-sync', 'Repair a detected OpenClaw config issue', { expectsJsonBody: true }),
      cmd('approvals', 'GET', '/openclaw/approvals', 'List pending OpenClaw execution approvals'),
      cmd('approvals-resolve', 'POST', '/openclaw/approvals', 'Resolve an OpenClaw execution approval', { expectsJsonBody: true }),
      cmd('cron', 'GET', '/openclaw/cron', 'List OpenClaw cron jobs'),
      cmd('cron-action', 'POST', '/openclaw/cron', 'Create/run/remove OpenClaw cron jobs', { expectsJsonBody: true }),
      cmd('agent-files', 'GET', '/openclaw/agent-files', 'Fetch OpenClaw agent files'),
      cmd('agent-files-set', 'PUT', '/openclaw/agent-files', 'Save an OpenClaw agent file', { expectsJsonBody: true }),
      cmd('dotenv-keys', 'GET', '/openclaw/dotenv-keys', 'List gateway .env keys'),
      cmd('exec-config', 'GET', '/openclaw/exec-config', 'Fetch OpenClaw exec approval config'),
      cmd('exec-config-set', 'PUT', '/openclaw/exec-config', 'Save OpenClaw exec approval config', { expectsJsonBody: true }),
      cmd('history-preview', 'GET', '/openclaw/history', 'Preview OpenClaw session history'),
      cmd('history-merge', 'POST', '/openclaw/history', 'Merge OpenClaw session history into local session', { expectsJsonBody: true }),
      cmd('media', 'GET', '/openclaw/media', 'Proxy OpenClaw media/file content'),
      cmd('models', 'GET', '/openclaw/models', 'List allowed OpenClaw models'),
      cmd('permissions', 'GET', '/openclaw/permissions', 'Get OpenClaw permission preset/config'),
      cmd('permissions-set', 'PUT', '/openclaw/permissions', 'Apply OpenClaw permission preset', { expectsJsonBody: true }),
      cmd('sandbox-env', 'GET', '/openclaw/sandbox-env', 'List OpenClaw sandbox env allowlist'),
      cmd('sandbox-env-set', 'PUT', '/openclaw/sandbox-env', 'Update OpenClaw sandbox env allowlist', { expectsJsonBody: true }),
      cmd('skills', 'GET', '/openclaw/skills', 'List OpenClaw skills and eligibility'),
      cmd('skills-update', 'PATCH', '/openclaw/skills', 'Update OpenClaw skill state/config', { expectsJsonBody: true }),
      cmd('skills-save', 'PUT', '/openclaw/skills', 'Save OpenClaw skill allowlist mode/config', { expectsJsonBody: true }),
      cmd('skills-install', 'POST', '/openclaw/skills/install', 'Install OpenClaw skill dependencies', { expectsJsonBody: true }),
      cmd('skills-remove', 'POST', '/openclaw/skills/remove', 'Remove OpenClaw skill', { expectsJsonBody: true }),
      cmd('sync', 'POST', '/openclaw/sync', 'Run OpenClaw sync action', { expectsJsonBody: true }),
      cmd('dashboard-url', 'GET', '/openclaw/dashboard-url', 'Get tokenized OpenClaw dashboard URL for an agent'),
      cmd('doctor', 'GET', '/openclaw/doctor', 'Run OpenClaw doctor check (read-only)'),
      cmd('doctor-fix', 'POST', '/openclaw/doctor', 'Run OpenClaw doctor with auto-fix', { expectsJsonBody: true }),
    ],
  },
  {
    name: 'preview-server',
    description: 'Manage preview dev servers',
    commands: [
      cmd('manage', 'POST', '/preview-server', 'Start/stop/status/detect preview server', { expectsJsonBody: true }),
    ],
  },
  {
    name: 'projects',
    description: 'Manage projects',
    commands: [
      cmd('list', 'GET', '/projects', 'List projects'),
      cmd('get', 'GET', '/projects/:id', 'Get project by id'),
      cmd('create', 'POST', '/projects', 'Create project', { expectsJsonBody: true }),
      cmd('update', 'PUT', '/projects/:id', 'Update project', { expectsJsonBody: true }),
      cmd('delete', 'DELETE', '/projects/:id', 'Delete project'),
    ],
  },
  {
    name: 'extensions',
    description: 'Manage extensions and marketplace',
    commands: [
      cmd('list', 'GET', '/extensions', 'List installed extensions'),
      cmd('set', 'POST', '/extensions', 'Enable or disable an extension', { expectsJsonBody: true }),
      cmd('delete', 'DELETE', '/extensions', 'Delete an external extension (use --query filename=extension.js)'),
      cmd('update', 'PATCH', '/extensions', 'Update an extension (use --query id=extension.js or --query all=true)'),
      cmd('install', 'POST', '/extensions/install', 'Install an extension from URL', { expectsJsonBody: true }),
      cmd('install-deps', 'POST', '/extensions/dependencies', 'Install or refresh extension workspace dependencies', { expectsJsonBody: true }),
      cmd('marketplace', 'GET', '/extensions/marketplace', 'Get extension marketplace catalog'),
      cmd('settings-get', 'GET', '/extensions/settings', 'Get extension settings (use --query extensionId=extension_name)'),
      cmd('settings-set', 'PUT', '/extensions/settings', 'Set extension settings (use --query extensionId=extension_name and --data JSON)', { expectsJsonBody: true }),
      cmd('ui', 'GET', '/extensions/ui', 'List extension UI modules (use --query type=sidebar|header|chat_actions|connectors)'),
      cmd('builtins', 'GET', '/extensions/builtins', 'List built-in extensions'),
    ],
  },
  {
    name: 'providers',
    description: 'Manage providers and model overrides',
    commands: [
      cmd('list', 'GET', '/providers', 'List providers'),
      cmd('get', 'GET', '/providers/:id', 'Get provider config'),
      cmd('create', 'POST', '/providers', 'Create custom provider', { expectsJsonBody: true }),
      cmd('update', 'PUT', '/providers/:id', 'Update provider', { expectsJsonBody: true }),
      cmd('delete', 'DELETE', '/providers/:id', 'Delete provider'),
      cmd('configs', 'GET', '/providers/configs', 'List saved provider configs'),
      cmd('discover-models', 'GET', '/providers/:id/discover-models', 'Discover provider models via endpoint or credential checks'),
      cmd('ollama', 'GET', '/providers/ollama', 'List local Ollama models (use --query endpoint=http://localhost:11434)'),
      cmd('openclaw-health', 'GET', '/providers/openclaw/health', 'Probe OpenClaw endpoint/auth (use --query endpoint= --query credentialId= --query model=)'),
      cmd('models', 'GET', '/providers/:id/models', 'Get provider model overrides'),
      cmd('models-set', 'PUT', '/providers/:id/models', 'Set provider model overrides', { expectsJsonBody: true }),
      cmd('models-clear', 'DELETE', '/providers/:id/models', 'Clear provider model overrides'),
    ],
  },
  {
    name: 'search',
    description: 'Global search across app resources',
    commands: [
      cmd('query', 'GET', '/search', 'Search agents/tasks/chats/schedules/webhooks/skills (use --query q=term)'),
    ],
  },
  {
    name: 'runs',
    description: 'Session run queue/history',
    commands: [
      cmd('list', 'GET', '/runs', 'List runs (use --query sessionId=, --query status=, --query limit=)'),
      cmd('get', 'GET', '/runs/:id', 'Get run by id'),
      cmd('events', 'GET', '/runs/:id/events', 'Get run event history by run id'),
    ],
  },
  {
    name: 'schedules',
    description: 'Manage schedules',
    commands: [
      cmd('list', 'GET', '/schedules', 'List schedules'),
      cmd('get', 'GET', '/schedules/:id', 'Get schedule by id', { virtual: true, clientGetRoute: '/schedules' }),
      cmd('create', 'POST', '/schedules', 'Create schedule', { expectsJsonBody: true }),
      cmd('update', 'PUT', '/schedules/:id', 'Update schedule', { expectsJsonBody: true }),
      cmd('delete', 'DELETE', '/schedules/:id', 'Delete schedule'),
      cmd('run', 'POST', '/schedules/:id/run', 'Trigger schedule now'),
    ],
  },
  {
    name: 'secrets',
    description: 'Manage reusable encrypted secrets',
    commands: [
      cmd('list', 'GET', '/secrets', 'List secrets metadata'),
      cmd('get', 'GET', '/secrets/:id', 'Get secret metadata by id', { virtual: true, clientGetRoute: '/secrets' }),
      cmd('create', 'POST', '/secrets', 'Create secret', { expectsJsonBody: true }),
      cmd('update', 'PUT', '/secrets/:id', 'Update secret metadata', { expectsJsonBody: true }),
      cmd('delete', 'DELETE', '/secrets/:id', 'Delete secret'),
    ],
  },
  {
    name: 'chats',
    description: 'Manage agent chats and runtime controls',
    commands: [
      cmd('list', 'GET', '/chats', 'List chats'),
      cmd('get', 'GET', '/chats/:id', 'Get chat by id'),
      cmd('create', 'POST', '/chats', 'Create chat', { expectsJsonBody: true }),
      cmd('update', 'PUT', '/chats/:id', 'Update chat', { expectsJsonBody: true }),
      cmd('delete', 'DELETE', '/chats/:id', 'Delete chat'),
      cmd('delete-many', 'DELETE', '/chats', 'Delete multiple chats (body: {"ids":[...]})', { expectsJsonBody: true }),
      cmd('heartbeat-disable-all', 'POST', '/chats/heartbeat', 'Disable all chat heartbeats and cancel queued heartbeat runs', {
        expectsJsonBody: true,
        defaultBody: { action: 'disable_all' },
      }),
      cmd('messages', 'GET', '/chats/:id/messages', 'Get chat messages'),
      cmd('messages-update', 'PUT', '/chats/:id/messages', 'Update chat message metadata (e.g. bookmark)', { expectsJsonBody: true }),
      cmd('messages-send', 'POST', '/chats/:id/messages', 'Append a user/system message to a chat', { expectsJsonBody: true }),
      cmd('messages-delete', 'DELETE', '/chats/:id/messages', 'Delete a message from a chat', { expectsJsonBody: true }),
      cmd('edit-resend', 'POST', '/chats/:id/edit-resend', 'Edit and resend from a specific message index', { expectsJsonBody: true }),
      cmd('chat', 'POST', '/chats/:id/chat', 'Send chat message (streaming)', {
        expectsJsonBody: true,
        responseType: 'sse',
      }),
      cmd('stop', 'POST', '/chats/:id/stop', 'Stop chat run(s)'),
      cmd('clear', 'POST', '/chats/:id/clear', 'Clear chat messages'),
      cmd('browser-status', 'GET', '/chats/:id/browser', 'Check browser status'),
      cmd('browser-close', 'DELETE', '/chats/:id/browser', 'Close browser'),
      cmd('mailbox', 'GET', '/chats/:id/mailbox', 'List chat mailbox envelopes'),
      cmd('mailbox-action', 'POST', '/chats/:id/mailbox', 'Send/ack/clear mailbox envelopes', { expectsJsonBody: true }),
      cmd('queue', 'GET', '/chats/:id/queue', 'List queued follow-up turns for a chat'),
      cmd('queue-add', 'POST', '/chats/:id/queue', 'Enqueue a follow-up turn for a busy chat', { expectsJsonBody: true }),
      cmd('queue-clear', 'DELETE', '/chats/:id/queue', 'Remove queued follow-up turns from a chat', { expectsJsonBody: true }),
      cmd('retry', 'POST', '/chats/:id/retry', 'Retry last assistant message'),
      cmd('deploy', 'POST', '/chats/:id/deploy', 'Deploy current chat branch', { expectsJsonBody: true }),
      cmd('devserver', 'POST', '/chats/:id/devserver', 'Dev server action via JSON body', { expectsJsonBody: true }),
      cmd('devserver-start', 'POST', '/chats/:id/devserver', 'Start chat dev server', {
        expectsJsonBody: true,
        defaultBody: { action: 'start' },
      }),
      cmd('devserver-stop', 'POST', '/chats/:id/devserver', 'Stop chat dev server', {
        expectsJsonBody: true,
        defaultBody: { action: 'stop' },
      }),
      cmd('devserver-status', 'POST', '/chats/:id/devserver', 'Check chat dev server status', {
        expectsJsonBody: true,
        defaultBody: { action: 'status' },
      }),
      cmd('checkpoints', 'GET', '/chats/:id/checkpoints', 'List checkpoint history for a chat'),
      cmd('migrate-messages', 'POST', '/chats/migrate-messages', 'Migrate messages from session blobs to relational table'),
    ],
  },
  {
    name: 'settings',
    description: 'Read/update app settings',
    commands: [
      cmd('get', 'GET', '/settings', 'Get settings'),
      cmd('update', 'PUT', '/settings', 'Update settings', { expectsJsonBody: true }),
    ],
  },
  {
    name: 'setup',
    description: 'Setup and provider validation helpers',
    commands: [
      cmd('check-provider', 'POST', '/setup/check-provider', 'Validate provider credentials/endpoint', { expectsJsonBody: true }),
      cmd('doctor', 'GET', '/setup/doctor', 'Run local setup diagnostics'),
      cmd('openclaw-device', 'GET', '/setup/openclaw-device', 'Show the local OpenClaw device ID'),
    ],
  },
  {
    name: 'learned-skills',
    description: 'Inspect agent-scoped learned skills',
    commands: [
      cmd('list', 'GET', '/learned-skills', 'List learned skills'),
      cmd('promote', 'POST', '/learned-skills/:id?action=promote', 'Promote a review-ready skill to active'),
      cmd('dismiss', 'POST', '/learned-skills/:id?action=dismiss', 'Dismiss a learned skill'),
      cmd('delete', 'DELETE', '/learned-skills/:id', 'Delete a learned skill'),
      cmd('review-counts', 'GET', '/skill-review-counts', 'Show pending review counts'),
    ],
  },
  {
    name: 'skills',
    description: 'Manage reusable skills',
    commands: [
      cmd('list', 'GET', '/skills', 'List skills'),
      cmd('get', 'GET', '/skills/:id', 'Get skill'),
      cmd('create', 'POST', '/skills', 'Create skill', { expectsJsonBody: true }),
      cmd('update', 'PUT', '/skills/:id', 'Update skill', { expectsJsonBody: true }),
      cmd('delete', 'DELETE', '/skills/:id', 'Delete skill'),
      cmd('import', 'POST', '/skills/import', 'Import skill from URL', { expectsJsonBody: true }),
    ],
  },
  {
    name: 'skill-suggestions',
    description: 'Review conversation-derived skill drafts',
    commands: [
      cmd('list', 'GET', '/skill-suggestions', 'List skill suggestions'),
      cmd('draft', 'POST', '/skill-suggestions', 'Generate or refresh a draft from a session', {
        expectsJsonBody: true,
        bodyFlagMap: { session: 'sessionId' },
      }),
      cmd('approve', 'POST', '/skill-suggestions/:id/approve', 'Approve a skill suggestion and materialize it'),
      cmd('reject', 'POST', '/skill-suggestions/:id/reject', 'Reject a skill suggestion draft'),
    ],
  },
  {
    name: 'souls',
    description: 'Browse and manage soul library templates',
    commands: [
      cmd('list', 'GET', '/souls', 'List soul templates'),
      cmd('get', 'GET', '/souls/:id', 'Get soul template by id'),
      cmd('create', 'POST', '/souls', 'Create custom soul template', { expectsJsonBody: true }),
      cmd('update', 'PUT', '/souls/:id', 'Update soul template', { expectsJsonBody: true }),
      cmd('delete', 'DELETE', '/souls/:id', 'Delete soul template'),
    ],
  },
  {
    name: 'tasks',
    description: 'Manage task board items',
    commands: [
      cmd('list', 'GET', '/tasks', 'List tasks'),
      cmd('get', 'GET', '/tasks/:id', 'Get task'),
      cmd('create', 'POST', '/tasks', 'Create task', { expectsJsonBody: true }),
      cmd('bulk', 'POST', '/tasks/bulk', 'Bulk update tasks (status/agent/project)', { expectsJsonBody: true }),
      cmd('update', 'PUT', '/tasks/:id', 'Update task', { expectsJsonBody: true }),
      cmd('delete', 'DELETE', '/tasks/:id', 'Delete task'),
      cmd('purge', 'DELETE', '/tasks', 'Bulk delete tasks', { expectsJsonBody: true }),
      cmd('approve', 'POST', '/tasks/:id/approve', 'Approve or reject a pending tool execution', { expectsJsonBody: true }),
      cmd('claim', 'POST', '/tasks/claim', 'Claim a pool-mode task for an agent', { expectsJsonBody: true }),
      cmd('import-github', 'POST', '/tasks/import/github', 'Import GitHub issues into tasks', { expectsJsonBody: true }),
      cmd('metrics', 'GET', '/tasks/metrics', 'Get task board metrics (supports --query range=24h|7d|30d)'),
    ],
  },
  {
    name: 'tts',
    description: 'Text-to-speech endpoint',
    commands: [
      cmd('speak', 'POST', '/tts', 'Generate TTS audio', {
        expectsJsonBody: true,
        responseType: 'binary',
        bodyFlagMap: { text: 'text' },
      }),
      cmd('stream', 'POST', '/tts/stream', 'Generate streaming TTS audio', {
        expectsJsonBody: true,
        responseType: 'binary',
        bodyFlagMap: { text: 'text' },
      }),
    ],
  },
  {
    name: 'wallets',
    description: 'Manage agent wallets and wallet transactions',
    commands: [
      cmd('list', 'GET', '/wallets', 'List wallets'),
      cmd('get', 'GET', '/wallets/:id', 'Get wallet by id'),
      cmd('create', 'POST', '/wallets', 'Create wallet', { expectsJsonBody: true }),
      cmd('update', 'PATCH', '/wallets/:id', 'Update wallet settings', { expectsJsonBody: true }),
      cmd('delete', 'DELETE', '/wallets/:id', 'Delete wallet'),
      cmd('send', 'POST', '/wallets/:id/send', 'Send funds from wallet', { expectsJsonBody: true }),
      cmd('approve', 'POST', '/wallets/:id/approve', 'Approve or deny a pending wallet transaction', { expectsJsonBody: true }),
      cmd('transactions', 'GET', '/wallets/:id/transactions', 'List wallet transactions'),
      cmd('balance-history', 'GET', '/wallets/:id/balance-history', 'Get wallet balance history'),
    ],
  },
  {
    name: 'upload',
    description: 'Upload raw file/blob',
    commands: [
      cmd('file', 'POST', '/upload', 'Upload file', {
        requestType: 'upload',
        inputPositional: 'filePath',
      }),
    ],
  },
  {
    name: 'uploads',
    description: 'Manage uploaded artifacts',
    commands: [
      cmd('list', 'GET', '/uploads', 'List uploaded artifacts'),
      cmd('get', 'GET', '/uploads/:filename', 'Download uploaded artifact', { responseType: 'binary' }),
      cmd('delete', 'DELETE', '/uploads/:filename', 'Delete uploaded artifact by filename'),
      cmd('delete-many', 'DELETE', '/uploads', 'Delete uploads by filter/body (filenames, olderThanDays, category, or all)', { expectsJsonBody: true }),
    ],
  },
  {
    name: 'system-status',
    description: 'Lightweight system health summary',
    commands: [
      cmd('get', 'GET', '/system/status', 'Get system health summary (safe for external monitors)'),
    ],
  },
  {
    name: 'usage',
    description: 'Usage and cost summary',
    commands: [
      cmd('get', 'GET', '/usage', 'Get usage summary'),
    ],
  },
  {
    name: 'version',
    description: 'Version and update checks',
    commands: [
      cmd('get', 'GET', '/version', 'Get local/remote version info'),
      cmd('update', 'POST', '/version/update', 'Update to latest stable release tag (fallback: main) and install deps when needed'),
    ],
  },
  {
    name: 'webhooks',
    description: 'Manage and trigger webhooks',
    commands: [
      cmd('list', 'GET', '/webhooks', 'List webhooks'),
      cmd('get', 'GET', '/webhooks/:id', 'Get webhook by id'),
      cmd('create', 'POST', '/webhooks', 'Create webhook', { expectsJsonBody: true }),
      cmd('update', 'PUT', '/webhooks/:id', 'Update webhook', { expectsJsonBody: true }),
      cmd('delete', 'DELETE', '/webhooks/:id', 'Delete webhook'),
      cmd('trigger', 'POST', '/webhooks/:id', 'Trigger webhook by id', {
        expectsJsonBody: true,
        waitEntityFrom: 'runId',
      }),
      cmd('history', 'GET', '/webhooks/:id/history', 'Get webhook delivery history'),
    ],
  },
]

const GROUP_MAP = new Map(COMMAND_GROUPS.map((group) => [group.name, group]))

function resolveGroup(name) {
  const group = GROUP_MAP.get(name)
  if (!group) return null
  if (group.aliasFor) {
    return GROUP_MAP.get(group.aliasFor) || null
  }
  return group
}

const COMMANDS = COMMAND_GROUPS.flatMap((group) => {
  if (group.aliasFor) return []
  return group.commands.map((command) => ({ ...command, group: group.name }))
})

function getCommand(groupName, action) {
  const group = resolveGroup(groupName)
  if (!group) return null
  return group.commands.find((command) => command.action === action) || null
}

function extractPathParams(route) {
  return [...route.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1])
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

function parseKeyValue(raw, kind) {
  const idx = raw.indexOf('=')
  if (idx === -1) {
    throw new Error(`${kind} value must be key=value: ${raw}`)
  }
  const key = raw.slice(0, idx).trim()
  const value = raw.slice(idx + 1)
  if (!key) throw new Error(`${kind} key cannot be empty`)
  return [key, value]
}

function parseDataInput(raw, stdin) {
  if (raw === '-') {
    return parseJsonText(readStdin(stdin), 'stdin')
  }
  if (raw.startsWith('@')) {
    const filePath = raw.slice(1)
    if (!filePath) throw new Error('Expected file path after @ for --data')
    const fileText = fs.readFileSync(filePath, 'utf8')
    return parseJsonText(fileText, filePath)
  }
  return parseJsonText(raw, '--data')
}

function parseJsonText(text, sourceName) {
  try {
    return JSON.parse(text)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Invalid JSON from ${sourceName}: ${msg}`)
  }
}

function readStdin(stdin) {
  const fd = stdin && typeof stdin.fd === 'number' ? stdin.fd : 0
  return fs.readFileSync(fd, 'utf8')
}

function normalizeBaseUrl(raw) {
  const trimmed = String(raw || '').trim()
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  return withProtocol.replace(/\/+$/, '')
}

function resolveAccessKey(opts, env, cwd) {
  if (opts.accessKey) return String(opts.accessKey).trim()
  const envKey = env.SWARMCLAW_API_KEY || env.SC_ACCESS_KEY || env.SWARMCLAW_ACCESS_KEY || ''
  if (envKey) return String(envKey).trim()

  const keyFile = path.join(cwd, 'platform-api-key.txt')
  if (fs.existsSync(keyFile)) {
    const content = fs.readFileSync(keyFile, 'utf8').trim()
    if (content) return content
  }
  return ''
}

function parseArgv(argv) {
  const result = {
    group: '',
    action: '',
    positionals: [],
    opts: {
      baseUrl: '',
      accessKey: '',
      jsonOutput: false,
      wait: false,
      timeoutMs: 300000,
      intervalMs: 2000,
      out: '',
      data: '',
      headers: [],
      query: [],
      key: '',
      text: '',
      file: '',
      filename: '',
      secret: '',
      event: '',
      help: false,
      version: false,
    },
  }

  const valueOptions = new Set([
    'base-url',
    'access-key',
    'timeout-ms',
    'interval-ms',
    'out',
    'data',
    'header',
    'query',
    'key',
    'text',
    'file',
    'filename',
    'secret',
    'event',
  ])

  const tokens = [...argv]
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === '--') {
      result.positionals.push(...tokens.slice(i + 1))
      break
    }

    if (token === '-h' || token === '--help') {
      result.opts.help = true
      continue
    }

    if (token === '--version') {
      result.opts.version = true
      continue
    }

    if (token === '--json') {
      result.opts.jsonOutput = true
      continue
    }

    if (token === '--wait') {
      result.opts.wait = true
      continue
    }

    if (token.startsWith('--')) {
      const eqIndex = token.indexOf('=')
      const hasInline = eqIndex > -1
      const rawName = hasInline ? token.slice(2, eqIndex) : token.slice(2)
      const rawValue = hasInline ? token.slice(eqIndex + 1) : ''

      if (!valueOptions.has(rawName)) {
        throw new Error(`Unknown option: --${rawName}`)
      }

      const value = hasInline ? rawValue : tokens[i + 1]
      if (!hasInline) i += 1
      if (value === undefined) {
        throw new Error(`Missing value for --${rawName}`)
      }

      switch (rawName) {
        case 'base-url':
          result.opts.baseUrl = value
          break
        case 'access-key':
          result.opts.accessKey = value
          break
        case 'timeout-ms':
          result.opts.timeoutMs = Number.parseInt(value, 10)
          if (!Number.isFinite(result.opts.timeoutMs) || result.opts.timeoutMs <= 0) {
            throw new Error(`Invalid --timeout-ms value: ${value}`)
          }
          break
        case 'interval-ms':
          result.opts.intervalMs = Number.parseInt(value, 10)
          if (!Number.isFinite(result.opts.intervalMs) || result.opts.intervalMs <= 0) {
            throw new Error(`Invalid --interval-ms value: ${value}`)
          }
          break
        case 'out':
          result.opts.out = value
          break
        case 'data':
          result.opts.data = value
          break
        case 'header':
          result.opts.headers.push(value)
          break
        case 'query':
          result.opts.query.push(value)
          break
        case 'key':
          result.opts.key = value
          break
        case 'text':
          result.opts.text = value
          break
        case 'file':
          result.opts.file = value
          break
        case 'filename':
          result.opts.filename = value
          break
        case 'secret':
          result.opts.secret = value
          break
        case 'event':
          result.opts.event = value
          break
        default:
          throw new Error(`Unhandled option parser branch: --${rawName}`)
      }
      continue
    }

    result.positionals.push(token)
  }

  if (result.positionals.length > 0) {
    result.group = result.positionals[0]
  }
  if (result.positionals.length > 1) {
    result.action = result.positionals[1]
  }

  return result
}

function buildRoute(routeTemplate, args) {
  const pathParams = extractPathParams(routeTemplate)
  if (args.length < pathParams.length) {
    throw new Error(`Missing required path args: ${pathParams.slice(args.length).join(', ')}`)
  }

  let route = routeTemplate
  for (let i = 0; i < pathParams.length; i += 1) {
    route = route.replace(`:${pathParams[i]}`, encodeURIComponent(String(args[i])))
  }

  const remaining = args.slice(pathParams.length)
  return { route, remaining, pathParams }
}

function buildApiUrl(baseUrl, route, queryEntries) {
  const normalizedBase = normalizeBaseUrl(baseUrl)
  const hasApiSuffix = normalizedBase.endsWith('/api')
  const url = new URL(`${normalizedBase}${hasApiSuffix ? '' : '/api'}${route}`)
  for (const [key, value] of queryEntries) {
    url.searchParams.set(key, value)
  }
  return url
}

async function parseResponse(res, forceType) {
  const ct = (res.headers.get('content-type') || '').toLowerCase()

  if (forceType === 'sse' || ct.includes('text/event-stream')) {
    return { type: 'sse', value: res.body }
  }

  if (forceType === 'binary') {
    const buf = Buffer.from(await res.arrayBuffer())
    return { type: 'binary', value: buf, contentType: ct }
  }

  if (ct.includes('application/json')) {
    const json = await res.json().catch(() => null)
    return { type: 'json', value: json }
  }

  if (ct.startsWith('text/') || ct.includes('xml') || ct.includes('javascript')) {
    const text = await res.text()
    return { type: 'text', value: text }
  }

  const buf = Buffer.from(await res.arrayBuffer())
  return { type: 'binary', value: buf, contentType: ct }
}

function writeJson(stdout, value, compact) {
  const text = compact ? JSON.stringify(value) : JSON.stringify(value, null, 2)
  stdout.write(`${text}\n`)
}

function writeText(stdout, value) {
  stdout.write(String(value))
  if (!String(value).endsWith('\n')) stdout.write('\n')
}

function writeBinary(stdout, stderr, buffer, outPath, cwd) {
  if (outPath) {
    const resolved = path.isAbsolute(outPath) ? outPath : path.join(cwd, outPath)
    fs.writeFileSync(resolved, buffer)
    stderr.write(`Saved ${buffer.length} bytes to ${resolved}\n`)
    return
  }

  if (stdout.isTTY) {
    throw new Error('Binary response requires --out <file> when writing to a TTY')
  }
  stdout.write(buffer)
}

async function consumeSse(body, stdout, stderr, jsonOutput) {
  if (!body || typeof body.getReader !== 'function') {
    throw new Error('Streaming response does not expose a reader')
  }

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const eventBoundary = /\r?\n\r?\n/

  function flushChunk(rawChunk) {
    const lines = rawChunk
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => line.trimEnd())
      .filter(Boolean)

    const dataLines = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())

    if (!dataLines.length) return
    const payload = dataLines.join('\n')

    let parsed
    try {
      parsed = JSON.parse(payload)
    } catch {
      writeText(stdout, payload)
      return
    }

    if (jsonOutput) {
      writeJson(stdout, parsed, true)
      return
    }

    if (isPlainObject(parsed) && parsed.t === 'md' && typeof parsed.text === 'string') {
      writeText(stdout, parsed.text)
      return
    }

    if (isPlainObject(parsed) && parsed.t === 'err' && typeof parsed.text === 'string') {
      writeText(stderr, parsed.text)
      return
    }

    writeJson(stdout, parsed, false)
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let match = eventBoundary.exec(buffer)
    while (match) {
      const splitIndex = match.index
      const delimiterLength = match[0].length
      const chunk = buffer.slice(0, splitIndex)
      buffer = buffer.slice(splitIndex + delimiterLength)
      flushChunk(chunk)
      match = eventBoundary.exec(buffer)
    }
  }

  const finalText = decoder.decode()
  if (finalText) buffer += finalText
  if (buffer.trim()) flushChunk(buffer)
}

async function fetchJson(fetchImpl, url, headers, timeoutMs) {
  const res = await fetchImpl(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  })

  const parsed = await parseResponse(res)
  if (!res.ok) {
    throw new Error(`Request failed (${res.status}): ${serializePayload(parsed.value)}`)
  }

  if (parsed.type !== 'json') {
    throw new Error(`Expected JSON response from ${url}`)
  }

  return parsed.value
}

function serializePayload(value) {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function getWaitId(payload, command) {
  if (!isPlainObject(payload)) return null

  if (command.waitEntityFrom && typeof payload[command.waitEntityFrom] === 'string') {
    return { type: command.waitEntityFrom === 'taskId' ? 'task' : 'run', id: payload[command.waitEntityFrom] }
  }

  if (typeof payload.runId === 'string') return { type: 'run', id: payload.runId }
  if (isPlainObject(payload.run) && typeof payload.run.id === 'string') return { type: 'run', id: payload.run.id }
  if (typeof payload.taskId === 'string') return { type: 'task', id: payload.taskId }

  return null
}

function isTerminalStatus(status) {
  const terminal = new Set([
    'completed',
    'complete',
    'done',
    'failed',
    'error',
    'stopped',
    'cancelled',
    'canceled',
    'timeout',
    'timed_out',
  ])
  return terminal.has(String(status || '').toLowerCase())
}

async function waitForEntity(opts) {
  const {
    entityType,
    entityId,
    fetchImpl,
    baseUrl,
    headers,
    timeoutMs,
    intervalMs,
    stdout,
    jsonOutput,
  } = opts

  const route = entityType === 'run' ? `/runs/${encodeURIComponent(entityId)}` : `/tasks/${encodeURIComponent(entityId)}`
  const deadline = Date.now() + timeoutMs

  while (Date.now() <= deadline) {
    const url = buildApiUrl(baseUrl, route, [])
    const payload = await fetchJson(fetchImpl, url, headers, timeoutMs)

    const status = isPlainObject(payload) ? payload.status : undefined
    if (status !== undefined) {
      stdout.write(`[wait] ${entityType} ${entityId}: ${status}\n`)
    }

    if (status !== undefined && isTerminalStatus(status)) {
      if (jsonOutput) writeJson(stdout, payload, true)
      else writeJson(stdout, payload, false)
      return
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  throw new Error(`Timed out waiting for ${entityType} ${entityId}`)
}

function renderGeneralHelp() {
  const lines = [
    'SwarmClaw CLI',
    '',
    'Usage:',
    '  swarmclaw',
    '  swarmclaw help [command]',
    '  swarmclaw run|start|stop|status|doctor|update|version',
    '  swarmclaw <group> <command> [args] [options]',
    '',
    'Global options:',
    '  --base-url <url>       API base URL (default: http://localhost:3456)',
    '  --access-key <key>     Access key override (else SWARMCLAW_API_KEY/SWARMCLAW_ACCESS_KEY or platform-api-key.txt)',
    '  --data <json|@file|->  Request JSON body',
    '  --query key=value      Query parameter (repeatable)',
    '  --header key=value     Extra HTTP header (repeatable)',
    '  --json                 Compact JSON output',
    '  --wait                 Wait for run/task completion when runId/taskId is returned',
    '  --timeout-ms <ms>      Request/wait timeout (default: 300000)',
    '  --interval-ms <ms>     Poll interval for --wait (default: 2000)',
    '  --out <file>           Write binary response to file',
    '  --help                 Show help',
    '  --version              Show package version',
    '',
    'Top-level commands:',
    '  run, start             Start the SwarmClaw server',
    '  stop                   Stop the detached SwarmClaw server',
    '  status                 Show local server status',
    '  doctor                 Show local install/build diagnostics',
    '  help                   Show root or command help',
    '  update                 Update this SwarmClaw installation',
    '  version                Show package version',
    '',
    'Groups:',
  ]

  for (const group of COMMAND_GROUPS) {
    if (group.aliasFor) {
      lines.push(`  ${group.name} (alias for ${group.aliasFor})`)
    } else {
      lines.push(`  ${group.name}`)
    }
  }

  lines.push('', 'Use "swarmclaw help <command>" or "swarmclaw <group> --help" for more detail.')
  return lines.join('\n')
}

function renderGroupHelp(groupName) {
  const group = GROUP_MAP.get(groupName)
  if (!group) {
    throw new Error(`Unknown command group: ${groupName}`)
  }

  const resolved = resolveGroup(groupName)
  if (!resolved) throw new Error(`Unable to resolve command group: ${groupName}`)

  const lines = [
    `Group: ${groupName}${group.aliasFor ? ` (alias for ${group.aliasFor})` : ''}`,
    group.description ? `Description: ${group.description}` : '',
    '',
    'Commands:',
  ].filter(Boolean)

  for (const command of resolved.commands) {
    const params = extractPathParams(command.route).map((name) => `<${name}>`).join(' ')
    const suffix = params ? ` ${params}` : ''
    lines.push(`  ${command.action}${suffix}  ${command.description}`)
  }

  return lines.join('\n')
}

async function runCli(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout
  const stderr = deps.stderr || process.stderr
  const stdin = deps.stdin || process.stdin
  const env = deps.env || process.env
  const cwd = deps.cwd || process.cwd()
  const fetchImpl = deps.fetchImpl || globalThis.fetch

  if (typeof fetchImpl !== 'function') {
    stderr.write('Global fetch is unavailable in this Node runtime. Use Node 18+ or provide a fetch implementation.\n')
    return 1
  }

  let parsed
  try {
    parsed = parseArgv(argv)
  } catch (err) {
    stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }

  if (parsed.opts.version) {
    const pkgPath = path.join(__dirname, '..', '..', 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    stdout.write(`${pkg.name || 'swarmclaw'} ${pkg.version || '0.0.0'}\n`)
    return 0
  }

  if (!parsed.group || parsed.opts.help) {
    if (parsed.group) {
      try {
        stdout.write(`${renderGroupHelp(parsed.group)}\n`)
        return 0
      } catch {
        // Fall through to general help for unknown group
      }
    }
    stdout.write(`${renderGeneralHelp()}\n`)
    return 0
  }

  if (!parsed.action) {
    try {
      stdout.write(`${renderGroupHelp(parsed.group)}\n`)
      return 0
    } catch (err) {
      stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      return 1
    }
  }

  const command = getCommand(parsed.group, parsed.action)
  if (!command) {
    stderr.write(`Unknown command: ${parsed.group} ${parsed.action}\n`)
    const group = resolveGroup(parsed.group)
    if (group) {
      stderr.write(`${renderGroupHelp(parsed.group)}\n`)
    } else {
      stderr.write(`${renderGeneralHelp()}\n`)
    }
    return 1
  }

  const pathArgs = parsed.positionals.slice(2)
  let routeInfo
  try {
    routeInfo = buildRoute(command.route, pathArgs)
  } catch (err) {
    stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }

  const accessKey = resolveAccessKey(parsed.opts, env, cwd)
  const baseUrl = parsed.opts.baseUrl || env.SWARMCLAW_BASE_URL || env.SWARMCLAW_URL || 'http://localhost:3456'

  const headerEntries = []
  for (const raw of parsed.opts.headers) {
    try {
      headerEntries.push(parseKeyValue(raw, 'header'))
    } catch (err) {
      stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      return 1
    }
  }

  if (parsed.opts.secret) {
    headerEntries.push(['x-webhook-secret', parsed.opts.secret])
  }

  const queryEntries = []
  for (const raw of parsed.opts.query) {
    try {
      queryEntries.push(parseKeyValue(raw, 'query'))
    } catch (err) {
      stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      return 1
    }
  }

  if (parsed.opts.event) {
    queryEntries.push(['event', parsed.opts.event])
  }

  let url
  try {
    url = buildApiUrl(baseUrl, routeInfo.route, queryEntries)
  } catch (err) {
    stderr.write(`Invalid --base-url: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }

  const headers = {
    ...Object.fromEntries(headerEntries),
  }
  if (accessKey) headers['X-Access-Key'] = accessKey

  try {
    if (command.clientGetRoute) {
      const collectionUrl = buildApiUrl(baseUrl, command.clientGetRoute, queryEntries)
      const payload = await fetchJson(fetchImpl, collectionUrl, headers, parsed.opts.timeoutMs)
      const id = pathArgs[0]
      const entity = extractById(payload, id)
      if (!entity) {
        stderr.write(`Entity not found for id: ${id}\n`)
        return 1
      }
      if (parsed.opts.jsonOutput) writeJson(stdout, entity, true)
      else writeJson(stdout, entity, false)
      return 0
    }

    const init = {
      method: command.method,
      headers,
      signal: AbortSignal.timeout(parsed.opts.timeoutMs),
    }

    if (command.requestType === 'upload') {
      const uploadPath = parsed.opts.file || routeInfo.remaining[0]
      if (!uploadPath) {
        throw new Error(`Missing file path. Usage: ${parsed.group} ${parsed.action} <filePath>`) }

      const resolvedUploadPath = path.isAbsolute(uploadPath) ? uploadPath : path.join(cwd, uploadPath)
      const fileBuffer = fs.readFileSync(resolvedUploadPath)
      const filename = parsed.opts.filename || path.basename(resolvedUploadPath)
      init.body = fileBuffer
      init.headers['x-filename'] = filename
      if (!init.headers['Content-Type']) init.headers['Content-Type'] = 'application/octet-stream'
    } else if (command.method !== 'GET' && command.method !== 'HEAD') {
      let body = undefined
      if (parsed.opts.data) {
        body = parseDataInput(parsed.opts.data, stdin)
      }

      if (!isPlainObject(body) && command.expectsJsonBody) {
        body = {}
      }

      if (command.defaultBody) {
        body = { ...(command.defaultBody || {}), ...(isPlainObject(body) ? body : {}) }
      }

      if (command.bodyFlagMap) {
        const mapped = {}
        for (const [flagName, bodyKey] of Object.entries(command.bodyFlagMap)) {
          const val = parsed.opts[flagName]
          if (val !== undefined && val !== '') {
            mapped[bodyKey] = val
          }
        }
        body = { ...(isPlainObject(body) ? body : {}), ...mapped }
      }

      if (body !== undefined) {
        init.body = JSON.stringify(body)
        init.headers['Content-Type'] = 'application/json'
      }
    }

    const res = await fetchImpl(url, init)
    const parsedResponse = await parseResponse(res, command.responseType)

    if (!res.ok) {
      const serialized = serializePayload(parsedResponse.value)
      stderr.write(`Request failed (${res.status} ${res.statusText}): ${serialized}\n`)
      return 1
    }

    if (parsedResponse.type === 'sse') {
      await consumeSse(parsedResponse.value, stdout, stderr, parsed.opts.jsonOutput)
      return 0
    }

    if (parsedResponse.type === 'binary') {
      writeBinary(stdout, stderr, parsedResponse.value, parsed.opts.out, cwd)
      return 0
    }

    if (parsedResponse.type === 'json') {
      if (parsed.opts.jsonOutput) writeJson(stdout, parsedResponse.value, true)
      else writeJson(stdout, parsedResponse.value, false)

      if (parsed.opts.wait) {
        const waitMeta = getWaitId(parsedResponse.value, command)
        if (waitMeta) {
          await waitForEntity({
            entityType: waitMeta.type,
            entityId: waitMeta.id,
            fetchImpl,
            baseUrl,
            headers,
            timeoutMs: parsed.opts.timeoutMs,
            intervalMs: parsed.opts.intervalMs,
            stdout,
            jsonOutput: parsed.opts.jsonOutput,
          })
        } else {
          stderr.write('--wait requested, but response did not include runId/taskId\n')
        }
      }
      return 0
    }

    writeText(stdout, parsedResponse.value)
    return 0
  } catch (err) {
    stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

function extractById(payload, id) {
  if (!id) return null

  if (Array.isArray(payload)) {
    return payload.find((entry) => entry && String(entry.id) === String(id)) || null
  }

  if (isPlainObject(payload)) {
    if (payload[id]) return payload[id]
    if (Array.isArray(payload.items)) {
      return payload.items.find((entry) => entry && String(entry.id) === String(id)) || null
    }
  }

  return null
}

function getApiCoveragePairs() {
  return COMMANDS
    .filter((command) => !command.virtual)
    .map((command) => `${command.method} ${command.route.split('?')[0]}`)
}

module.exports = {
  COMMAND_GROUPS,
  COMMANDS,
  parseArgv,
  runCli,
  getCommand,
  getApiCoveragePairs,
  buildApiUrl,
  extractPathParams,
  resolveGroup,
  renderGeneralHelp,
  renderGroupHelp,
}
