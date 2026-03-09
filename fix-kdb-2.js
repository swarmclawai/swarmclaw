const fs = require('fs');
let kdb = fs.readFileSync('src/lib/server/knowledge-db.test.ts', 'utf8');

// Function takes 1 arg but we gave it 9. Let's look at it:
// `stmts.insert.run(` ...
// Actually the signature probably changed to take an object.
kdb = kdb.replace(/stmts\.insert\.run\([\s\S]*?now,\s*now,\s*\)/g, `stmts.insert.run({
    id: data.id || 'mem-1',
    agentId: data.agentId || null,
    sessionId: data.sessionId || null,
    taskId: data.taskId || null,
    url: data.url || null,
    category: data.category,
    textContent: data.textContent || null,
    createdAt: now,
    updatedAt: now
  })`);

fs.writeFileSync('src/lib/server/knowledge-db.test.ts', kdb);
