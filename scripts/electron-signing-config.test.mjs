import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('macOS desktop signing configuration', () => {
  it('keeps Developer ID signing and notarization available for release builds', () => {
    const builderConfig = fs.readFileSync(path.join(repoRoot, 'electron-builder.yml'), 'utf8')
    const desktopWorkflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'desktop-release.yml'), 'utf8')

    assert.ok(builderConfig.includes('hardenedRuntime: true'))
    assert.equal(builderConfig.includes("identity: '-'"), false)
    assert.equal(builderConfig.includes('identity: "-"'), false)

    for (const secretName of [
      'CSC_LINK',
      'CSC_KEY_PASSWORD',
      'APPLE_ID',
      'APPLE_APP_SPECIFIC_PASSWORD',
      'APPLE_TEAM_ID',
      'APPLE_API_KEY',
      'APPLE_API_KEY_ID',
      'APPLE_API_ISSUER',
    ]) {
      assert.ok(
        desktopWorkflow.includes(`${secretName}_SECRET: \${{ secrets.${secretName} }}`),
        `desktop release workflow should read ${secretName} through a guarded secret alias`,
      )
      assert.ok(
        desktopWorkflow.includes(`append_env ${secretName} "$${secretName}_SECRET"`),
        `desktop release workflow should export ${secretName} only after guard checks`,
      )
      assert.equal(
        desktopWorkflow.includes(`          ${secretName}: \${{ secrets.${secretName} }}`),
        false,
        `desktop release build step should not pass empty ${secretName} directly to electron-builder`,
      )
    }

    assert.equal(desktopWorkflow.includes("CSC_IDENTITY_AUTO_DISCOVERY: 'false'"), false)
    assert.equal(desktopWorkflow.includes('CSC_IDENTITY_AUTO_DISCOVERY: "false"'), false)

    assert.ok(
      desktopWorkflow.includes('echo "SWARMCLAW_ELECTRON_MAC_TARGETS=dmg,zip" >> "$GITHUB_ENV"'),
      'signed macOS desktop releases should keep publishing dmg + zip artifacts',
    )
    assert.ok(
      desktopWorkflow.includes('echo "SWARMCLAW_ELECTRON_MAC_TARGETS=zip" >> "$GITHUB_ENV"'),
      'unsigned macOS desktop releases should fall back to zip-only artifacts',
    )
    assert.ok(
      fs.readFileSync(path.join(repoRoot, 'scripts', 'build-electron.mjs'), 'utf8').includes('SWARMCLAW_ELECTRON_MAC_TARGETS'),
      'electron build script should honor mac target overrides from the workflow',
    )
  })
})
