const fs = require('fs');

const content = fs.readFileSync('src/lib/server/connectors/manager.ts', 'utf8');

const functions = [];
const regex = /^(?:export )?(?:async )?function (\w+)/gm;
let match;
while ((match = regex.exec(content)) !== null) {
  functions.push(match[1]);
}

console.log('Functions in manager.ts:', functions.length);
console.log(functions.join(', '));
