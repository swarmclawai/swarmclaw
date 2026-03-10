const fs = require('fs');

let mp = fs.readFileSync('src/lib/server/memory/memory-policy.test.ts', 'utf8');
// Fix the inline comment that broke the parens
mp = mp.replace(/assert\.equal\(shouldAutoCaptureMemory\(\{ message: 'Please save this to memory', response: 'Stored memory "note"\.', \/\/ source: 'chat' \}\), false\)/g, "assert.equal(shouldAutoCaptureMemory({ message: 'Please save this to memory', response: 'Stored memory \"note\".' }), false)");
mp = mp.replace(/assert\.equal\(shouldAutoCaptureMemory\(\{ message: 'thanks', response: 'Happy to help with that\.', \/\/ source: 'chat' \}\), false\)/g, "assert.equal(shouldAutoCaptureMemory({ message: 'thanks', response: 'Happy to help with that.' }), false)");
fs.writeFileSync('src/lib/server/memory/memory-policy.test.ts', mp);
