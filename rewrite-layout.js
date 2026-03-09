const fs = require('fs');

const path = 'src/components/layout/app-layout.tsx';
let content = fs.readFileSync(path, 'utf8');

// Add SheetLayer import
if (!content.includes("import { SheetLayer }")) {
  content = content.replace("import { HomeView }", "import { SheetLayer } from './sheet-layer'\nimport { HomeView }");
}

// Delete static imports
const toRemove = [
  "import { AgentSheet } from '@/components/agents/agent-sheet'",
  "import { ScheduleSheet } from '@/components/schedules/schedule-sheet'",
  "import { MemorySheet } from '@/components/memory/memory-sheet'",
  "import { TaskSheet } from '@/components/tasks/task-sheet'",
  "import { SecretSheet } from '@/components/secrets/secret-sheet'",
  "import { ProviderSheet } from '@/components/providers/provider-sheet'",
  "import { GatewaySheet } from '@/components/gateways/gateway-sheet'",
  "import { SkillSheet } from '@/components/skills/skill-sheet'",
  "import { ConnectorSheet } from '@/components/connectors/connector-sheet'",
  "import { ChatroomSheet } from '@/components/chatrooms/chatroom-sheet'",
  "import { WebhookSheet } from '@/components/webhooks/webhook-sheet'",
  "import { McpServerSheet } from '@/components/mcp-servers/mcp-server-sheet'",
  "import { KnowledgeSheet } from '@/components/knowledge/knowledge-sheet'",
  "import { PluginSheet } from '@/components/plugins/plugin-sheet'",
  "import { ProjectSheet } from '@/components/projects/project-sheet'",
  "import { SearchDialog } from '@/components/shared/search-dialog'",
  "import { AgentSwitchDialog } from '@/components/shared/agent-switch-dialog'",
  "import { KeyboardShortcutsDialog } from '@/components/shared/keyboard-shortcuts-dialog'",
  "import { ProfileSheet } from '@/components/shared/profile-sheet'"
];

for (const line of toRemove) {
  content = content.replace(line + "\n", "");
}

// Replace the rendered tags
const sheetTagsRegex = /<AgentSheet \/>[\s\S]*?<ProfileSheet open=\{profileSheetOpen\} onOpenChange=\{setProfileSheetOpen\} \/>/;
if (sheetTagsRegex.test(content)) {
  content = content.replace(sheetTagsRegex, "<SheetLayer profileSheetOpen={profileSheetOpen} setProfileSheetOpen={setProfileSheetOpen} />");
} else {
  console.log("Could not find block to replace");
}

fs.writeFileSync(path, content);
console.log("Layout rewritten");
