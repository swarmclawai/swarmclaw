import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../../..')

function runWithTempDataDir(script: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-clawhub-install-route-'))
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATA_DIR: path.join(tempDir, 'data'),
        WORKSPACE_DIR: path.join(tempDir, 'workspace'),
        SWARMCLAW_HOME: path.join(tempDir, 'swarmclaw-home'),
      },
      encoding: 'utf-8',
    })
    assert.equal(result.status, 0, result.stderr || result.stdout || 'subprocess failed')
    const lines = (result.stdout || '')
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    const jsonLine = [...lines].reverse().find((line) => line.startsWith('{'))
    return JSON.parse(jsonLine || '{}')
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

test('POST /api/clawhub/install materializes bundle files into the workspace skills directory', () => {
  const output = runWithTempDataDir(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const JSZip = (await import('jszip')).default
    const storageMod = await import('./src/lib/server/storage')
    const routeMod = await import('./src/app/api/clawhub/install/route')
    const storage = storageMod.default || storageMod
    const route = routeMod.default || routeMod

    const archive = new JSZip()
    archive.file('SKILL.md', \`---
name: test-hub-skill
description: A ClawHub test skill.
---

# Test Hub Skill

Use this skill when the user asks for a ClawHub installation test.
\`)
    archive.file('scripts/run.sh', '#!/bin/sh\\necho hi\\n')
    archive.file('references/notes.md', '# Notes\\n')
    const zipBuffer = await archive.generateAsync({ type: 'nodebuffer' })

    globalThis.fetch = async () => new Response(zipBuffer, {
      status: 200,
      headers: { 'content-type': 'application/zip' },
    })

    const response = await route.POST(new Request('http://local/api/clawhub/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'test-hub-skill',
        description: 'A ClawHub test skill.',
        url: 'https://clawhub.ai/skills/test-hub-skill',
        author: 'ClawHub',
        tags: ['test'],
      }),
    }))
    const payload = await response.json()
    const skillsDir = path.join(process.env.SWARMCLAW_HOME, 'skills', 'test-hub-skill')
    const storedSkills = storage.loadSkills()
    const stored = Object.values(storedSkills).find((skill) => skill.name === 'test-hub-skill')

    console.log(JSON.stringify({
      status: response.status,
      installedName: payload?.name || null,
      storedSkillId: stored?.id || null,
      hasWorkspaceSkill: fs.existsSync(path.join(skillsDir, 'SKILL.md')),
      hasWorkspaceScript: fs.existsSync(path.join(skillsDir, 'scripts', 'run.sh')),
      hasWorkspaceReference: fs.existsSync(path.join(skillsDir, 'references', 'notes.md')),
    }))
  `)

  assert.equal(output.status, 200)
  assert.equal(output.installedName, 'test-hub-skill')
  assert.notEqual(output.storedSkillId, null)
  assert.equal(output.hasWorkspaceSkill, true)
  assert.equal(output.hasWorkspaceScript, true)
  assert.equal(output.hasWorkspaceReference, true)
})
