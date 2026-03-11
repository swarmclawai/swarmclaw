import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { formatWebSearchResults, inferWebActionFromArgs, normalizeBrowserActionParams, resolveBrowserNavigationTarget } from './web'
import { UPLOAD_DIR } from '../storage'
import { createSandboxFsBridge } from '@/lib/server/sandbox/fs-bridge'

describe('inferWebActionFromArgs', () => {
  it('defaults to search when only query text is provided', () => {
    assert.equal(inferWebActionFromArgs({ query: 'latest US-Iran news' }), 'search')
  })

  it('defaults to fetch when the url is an absolute http url', () => {
    assert.equal(inferWebActionFromArgs({ url: 'https://example.com/article' }), 'fetch')
  })

  it('preserves an explicit action when present', () => {
    assert.equal(inferWebActionFromArgs({ action: 'search', url: 'https://example.com/article' }), 'search')
  })

  it('normalizes stringified browser form payloads', () => {
    const normalized = normalizeBrowserActionParams({
      input: JSON.stringify({
        action: 'fill_form',
        fields: JSON.stringify([
          { element: "input[name='email']", value: 'user@example.com' },
        ]),
        form: JSON.stringify({
          password: 'secret',
        }),
      }),
    })

    assert.equal(normalized.action, 'fill_form')
    assert.deepEqual(normalized.fields, [
      { element: "input[name='email']", value: 'user@example.com' },
    ])
    assert.deepEqual(normalized.form, { password: 'secret' })
  })

  it('maps selector and code aliases for browser actions', () => {
    const evaluate = normalizeBrowserActionParams({
      action: 'evaluate',
      selector: "input[name='email']",
      code: 'document.title',
    })
    const select = normalizeBrowserActionParams({
      action: 'select',
      selector: 'select[name="plan"]',
      value: 'pro',
    })

    assert.equal(evaluate.element, "input[name='email']")
    assert.equal(evaluate.function, '() => (document.title)')
    assert.equal(select.element, 'select[name="plan"]')
    assert.deepEqual(select.values, ['pro'])
  })

  it('wraps bare browser run_code snippets into a Playwright function', () => {
    const normalized = normalizeBrowserActionParams({
      action: 'run_code',
      code: "await page.goto('https://example.com'); return await page.title();",
    })

    assert.equal(
      normalized.code,
      "async (page) => { await page.goto('https://example.com'); return await page.title(); }",
    )
  })

  it('resolves local relative html files to browser-safe data urls for navigation', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-local-nav-'))
    const htmlPath = path.join(cwd, 'todo', 'index.html')
    fs.mkdirSync(path.dirname(htmlPath), { recursive: true })
    fs.writeFileSync(htmlPath, '<!doctype html><title>todo</title>')

    try {
      const resolved = resolveBrowserNavigationTarget(cwd, 'todo/index.html')
      assert.match(resolved, /^data:text\/html/i)
      assert.match(decodeURIComponent(resolved), /<title>todo<\/title>/i)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('resolves sandbox upload html urls to browser-safe data urls for navigation', () => {
    const filename = `browser-upload-${Date.now()}.html`
    const uploadPath = path.join(UPLOAD_DIR, filename)
    fs.mkdirSync(UPLOAD_DIR, { recursive: true })
    fs.writeFileSync(uploadPath, '<!doctype html><title>upload</title>')

    try {
      const resolved = resolveBrowserNavigationTarget(process.cwd(), `sandbox:/api/uploads/${filename}`)
      assert.match(resolved, /^data:text\/html/i)
      assert.match(decodeURIComponent(resolved), /<title>upload<\/title>/i)
    } finally {
      fs.rmSync(uploadPath, { force: true })
    }
  })

  it('resolves file urls for local html files to browser-safe data urls for navigation', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-file-url-nav-'))
    const htmlPath = path.join(cwd, 'launch.html')
    fs.writeFileSync(htmlPath, '<!doctype html><title>launch</title>')

    try {
      const resolved = resolveBrowserNavigationTarget(cwd, `file://${htmlPath}`)
      assert.match(resolved, /^data:text\/html/i)
      assert.match(decodeURIComponent(resolved), /<title>launch<\/title>/i)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('keeps multi-file html bundles on file:// urls so relative assets still load', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-bundle-nav-'))
    const htmlPath = path.join(cwd, 'index.html')
    fs.writeFileSync(
      htmlPath,
      '<!doctype html><html><head><script src="./app.js"></script></head><body>bundle</body></html>',
    )
    fs.writeFileSync(path.join(cwd, 'app.js'), 'window.BUNDLE_OK = true')

    try {
      const resolved = resolveBrowserNavigationTarget(cwd, './index.html')
      assert.match(resolved, /^file:\/\//i)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('maps local html bundles to sandbox file urls when a sandbox fs bridge is present', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-sandbox-nav-'))
    fs.mkdirSync(path.join(cwd, 'app'), { recursive: true })
    fs.writeFileSync(path.join(cwd, 'app', 'index.html'), '<!doctype html><title>sandbox</title>')
    const bridge = createSandboxFsBridge({
      workspaceDir: cwd,
      containerWorkdir: '/workspace',
      workspaceAccess: 'rw',
    })

    try {
      const resolved = resolveBrowserNavigationTarget(
        path.join(cwd, 'app'),
        './index.html',
        bridge,
      )

      assert.equal(resolved, 'file:///workspace/app/index.html')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('formatWebSearchResults', () => {
  it('preserves source titles, urls, and snippets in plain text output', () => {
    const formatted = formatWebSearchResults('Iran war latest updates', [
      {
        title: 'Reuters - Regional escalation update',
        url: 'https://www.reuters.com/world/middle-east/example',
        snippet: 'Fresh reporting on overnight developments and diplomatic fallout.',
      },
      {
        title: 'BBC News - Timeline',
        url: 'https://www.bbc.com/news/example',
        snippet: 'A concise chronology of the conflict and response.',
      },
    ])

    assert.match(formatted, /Search results for: Iran war latest updates/)
    assert.match(formatted, /1\. Reuters - Regional escalation update/)
    assert.match(formatted, /URL: https:\/\/www\.reuters\.com\/world\/middle-east\/example/)
    assert.match(formatted, /Snippet: Fresh reporting on overnight developments/)
    assert.match(formatted, /2\. BBC News - Timeline/)
    assert.match(formatted, /URL: https:\/\/www\.bbc\.com\/news\/example/)
  })

  it('keeps urls visible when the result set has to be truncated', () => {
    const formatted = formatWebSearchResults(
      'long query',
      [
        {
          title: 'Very long source',
          url: 'https://example.com/source',
          snippet: 'x'.repeat(500),
        },
        {
          title: 'Second source',
          url: 'https://example.com/second',
          snippet: 'y'.repeat(500),
        },
      ],
      140,
    )

    assert.match(formatted, /URL: https:\/\/example\.com\/source/)
    assert.doesNotMatch(formatted, /^\s*\[/)
  })
})
