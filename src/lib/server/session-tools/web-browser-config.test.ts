import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildBrowserConnectionOptions, buildBrowserStdioServerParams, sanitizePlaywrightMcpEnv } from './web'

describe('browser tool connection config', () => {
  it('does not opt into Playwright shared browser contexts', () => {
    const config = buildBrowserConnectionOptions('/tmp/swarmclaw-browser-profile')

    assert.equal(config.sharedBrowserContext, false)
    assert.equal(config.browser.userDataDir, '/tmp/swarmclaw-browser-profile')
    assert.deepEqual(config.browser.contextOptions.viewport, { width: 1440, height: 900 })
  })

  it('spawns a dedicated stdio MCP server with an isolated profile directory', () => {
    const params = buildBrowserStdioServerParams('/tmp/swarmclaw-browser-profile')

    assert.equal(params.command, process.execPath)
    assert.equal(params.args.includes('--headless'), true)
    assert.equal(params.args.includes('--shared-browser-context'), false)
    assert.equal(params.args.includes('/tmp/swarmclaw-browser-profile'), true)
    assert.equal(params.env.PLAYWRIGHT_MCP_USER_DATA_DIR, '/tmp/swarmclaw-browser-profile')
    assert.equal(params.env.PLAYWRIGHT_MCP_OUTPUT_MODE, 'file')
  })

  it('strips host Playwright MCP env overrides before applying the local browser config', () => {
    const env = sanitizePlaywrightMcpEnv({
      NODE_ENV: 'test',
      PLAYWRIGHT_MCP_CONFIG: '/tmp/evil-config.json',
      PLAYWRIGHT_MCP_SHARED_BROWSER_CONTEXT: '1',
      PLAYWRIGHT_MCP_TIMEOUT_ACTION: '999999',
      OTHER_ENV: 'keep-me',
    })

    assert.equal(env.PLAYWRIGHT_MCP_CONFIG, undefined)
    assert.equal(env.PLAYWRIGHT_MCP_SHARED_BROWSER_CONTEXT, undefined)
    assert.equal(env.PLAYWRIGHT_MCP_TIMEOUT_ACTION, undefined)
    assert.equal(env.OTHER_ENV, 'keep-me')
  })
})
