import { performGuardianRollback } from '../src/lib/server/agents/guardian'
import { applyMMR } from '../src/lib/server/mmr'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'

// Mock types for MMR test
interface MemoryEntry {
  id: string
  title: string
  content: string
  category: string
  createdAt: number
  updatedAt: number
  [key: string]: unknown
}

async function runTests() {
  console.log('🚀 Starting SwarmClaw Advanced Feature Validation...\n')

  // --- 1. Test MMR Diversity ---
  console.log('--- Testing MMR (Maximal Marginal Relevance) ---')
  
  // Use distinct embeddings
  const queryEmbedding = [1, 0, 0] 
  const now = Date.now()
  const candidates = [
    {
      entry: { id: '1', title: 'Python Loop', content: 'How to write a for loop in python', category: 'note', createdAt: now, updatedAt: now } as MemoryEntry,
      salience: 0.9,
      embedding: [1, 0.1, 0] // High relevance
    },
    {
      entry: { id: '2', title: 'Python For', content: 'Writing for loops in python language', category: 'note', createdAt: now, updatedAt: now } as MemoryEntry,
      salience: 0.89,
      embedding: [1, 0.11, 0] // High relevance, but almost identical to #1
    },
    {
      entry: { id: '3', title: 'React Hooks', content: 'Using useEffect and useState in React', category: 'note', createdAt: now, updatedAt: now } as MemoryEntry,
      salience: 0.7,
      embedding: [0, 1, 0] // Lower relevance, but very diverse
    },
  ]

  console.log('Running MMR with lambda=0.2 (High Diversity)...')
  const diverseResults = applyMMR(queryEmbedding, candidates, 2, 0.2)
  console.log('Selected IDs:', diverseResults.map(r => r.id))
  
  // With lambda=0.2, ID '3' should definitely be picked over '2'
  if (diverseResults.some(r => r.id === '3')) {
    console.log('✅ MMR Diversity Test Passed!')
  } else {
    console.log('❌ MMR Diversity Test Failed: Diversity still not prioritized.')
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
    console.log('Simulating workspace corruption...')
    
    const rollback = performGuardianRollback(testRepoDir)
    const restoredContent = fs.readFileSync(path.join(testRepoDir, 'config.json'), 'utf8')
    
    if (rollback.ok && restoredContent.includes('ok')) {
      console.log('✅ Guardian Rollback Test Passed! (Clean state restored)')
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
