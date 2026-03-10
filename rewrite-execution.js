const fs = require('fs');

const path = 'src/lib/server/chat-execution/chat-execution.ts';
let content = fs.readFileSync(path, 'utf8');

// I will just remove the setup functions from chat-execution since they are exported from setup.ts
content = content.replace(/export function buildAgentSystemPrompt[\s\S]*?return combined \|\| 'You are a helpful AI assistant\.'\n\}/m, '');
content = content.replace(/export function resolveApiKeyForSession[\s\S]*?return undefined\n\}/m, '');
content = content.replace(/export function syncSessionFromAgent[\s\S]*?\}\n\}/m, '');

// And import them at the top
if (!content.includes('./chat-execution/setup')) {
  content = content.replace(/import fs from 'fs'/, "import fs from 'fs'\nimport { buildAgentSystemPrompt, resolveApiKeyForSession, syncSessionFromAgent } from './chat-execution/setup'");
}

fs.writeFileSync(path, content);
