const fs = require('fs');

const content = fs.readFileSync('src/lib/server/eval/agent-regression.ts', 'utf8');
const functions = [];
const regex = /^(?:export )?(?:async )?function (\w+)/gm;
let match;
while ((match = regex.exec(content)) !== null) {
  functions.push(match[1]);
}
console.log('Functions in agent-regression.ts:', functions.length);
console.log(functions.join(', '));
