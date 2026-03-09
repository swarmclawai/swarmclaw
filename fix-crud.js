const fs = require('fs');

let content = fs.readFileSync('src/lib/server/session-tools/crud.ts', 'utf8');

// The `preparedManagedSchedule` needs to be defined as `any` or `Schedule | null`
content = content.replace(/let preparedManagedSchedule: Record<string, unknown> \| null = null/g, 'let preparedManagedSchedule: any = null');

fs.writeFileSync('src/lib/server/session-tools/crud.ts', content);
