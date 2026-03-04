import { performGuardianRollback } from '../src/lib/server/guardian'
import { applyMMR } from '../src/lib/server/mmr'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'

async function runTests() {
  console.log('🚀 Starting SwarmClaw Advanced Feature Validation...\n')

  // --- 1. Test MMR Diversity ---
  console.log('--- Testing MMR (Maximal Marginal Relevance) ---')
  const queryEmbedding = Array(1536).fill(0.1) // Mock embedding
  const candidates = [
    { 
      entry: { id: '1', title: 'Python Loop', content: 'How to write a for loop in python', category: 'note' }, 
      salience: 0.9, 
      embedding: Array(1536).fill(0.1) 
    },
    { 
      entry: { id: '2', title: 'Python For', content: 'Writing for loops in python language', category: 'note' }, 
      salience: 0.89, 
      embedding: Array(1536).fill(0.101) 
    }, // Very similar to #1
    { 
      entry: { id: '3', title: 'React Hooks', content: 'Using useEffect and useState in React', category: 'note' }, 
      salience: 0.7, 
      embedding: Array(1536).fill(0.5) 
    }, // Different topic
  ]

  const diverseResults = applyMMR(queryEmbedding, candidates, 2, 0.5)
  console.log('Selected IDs (should favor 1 and 3 over 2 due to diversity):', diverseResults.map(r => r.id))
  if (diverseResults.some(r => r.id === '3') && !diverseResults.some(r => r.id === '2')) {
    console.log('✅ MMR Diversity Test Passed!')
  } else {
    console.log('⚠️ MMR Diversity Test: Diversity not maximized as expected.')
  }

  // --- 2. Test Guardian Rollback ---
  console.log('\n--- Testing Guardian Auto-Recovery (Rollback) ---')
  const testRepoDir = path.join(os.tmpdir(), `swarmclaw-test-repo-${Date.now()}`)
  fs.mkdirSync(testRepoDir)
  
  try {
    execSync('git init', { cwd: testRepoDir })
    execSync('git config user.email "test@example.com"', { cwd: testRepoDir })
    execSync('git config user.name "Test User"', { cwd: testRepoDir })
    fs.writeFileSync(path.join(testRepoDir, 'config.json'), '{"status": "ok"}')
    execSync('git add . && git commit -m "Initial commit"', { cwd: testRepoDir })
    
    // Corrupt the file
    fs.writeFileSync(path.join(testRepoDir, 'config.json'), '{"status": "CORRUPTED"}')
    console.log('Current state: Corrupted (Uncommitted)')
    
    const rollback = performGuardianRollback(testRepoDir)
    const restoredContent = fs.readFileSync(path.join(testRepoDir, 'config.json'), 'utf8')
    
    if (rollback.ok && restoredContent.includes('ok')) {
      console.log('✅ Guardian Rollback Test Passed!')
    } else {
      console.log('❌ Guardian Rollback Test Failed!')
    }
  } catch (err) {
    console.error('Guardian test error:', err)
  } finally {
    try { fs.rmSync(testRepoDir, { recursive: true, force: true }) } catch {}
  }

  console.log('\n--- Validation Complete ---')
}

runTests().catch(console.error)
