import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  canonicalizePluginId,
  expandPluginIds,
  getPluginAliases,
  normalizePluginId,
  pluginIdMatches,
} from './tool-aliases'

// ---------------------------------------------------------------------------
// normalizePluginId
// ---------------------------------------------------------------------------
describe('normalizePluginId', () => {
  it('converts uppercase to lowercase', () => {
    assert.equal(normalizePluginId('WEB_SEARCH'), 'web_search')
  })

  it('trims leading and trailing whitespace', () => {
    assert.equal(normalizePluginId('  shell  '), 'shell')
  })

  it('handles combined upper + whitespace', () => {
    assert.equal(normalizePluginId('  WEB_SEARCH  '), 'web_search')
  })

  it('returns empty string for empty input', () => {
    assert.equal(normalizePluginId(''), '')
  })

  it('returns already normalized value unchanged', () => {
    assert.equal(normalizePluginId('files'), 'files')
  })

  it('returns empty string for non-string input (number)', () => {
    assert.equal(normalizePluginId(42), '')
  })

  it('returns empty string for null', () => {
    assert.equal(normalizePluginId(null), '')
  })

  it('returns empty string for undefined', () => {
    assert.equal(normalizePluginId(undefined), '')
  })
})

// ---------------------------------------------------------------------------
// canonicalizePluginId
// ---------------------------------------------------------------------------
describe('canonicalizePluginId', () => {
  it('resolves web_search → web', () => {
    assert.equal(canonicalizePluginId('web_search'), 'web')
  })

  it('resolves web_fetch → web', () => {
    assert.equal(canonicalizePluginId('web_fetch'), 'web')
  })

  it('keeps web (already canonical)', () => {
    assert.equal(canonicalizePluginId('web'), 'web')
  })

  it('resolves execute_command → shell', () => {
    assert.equal(canonicalizePluginId('execute_command'), 'shell')
  })

  it('resolves memory_tool → memory', () => {
    assert.equal(canonicalizePluginId('memory_tool'), 'memory')
  })

  it('resolves narrow memory tools → memory', () => {
    assert.equal(canonicalizePluginId('memory_search'), 'memory')
    assert.equal(canonicalizePluginId('memory_get'), 'memory')
    assert.equal(canonicalizePluginId('memory_store'), 'memory')
    assert.equal(canonicalizePluginId('memory_update'), 'memory')
  })

  it('keeps files (already canonical)', () => {
    assert.equal(canonicalizePluginId('files'), 'files')
  })

  it('returns unknown plugin as-is', () => {
    assert.equal(canonicalizePluginId('totally_unknown'), 'totally_unknown')
  })

  it('resolves delegate_to_claude_code → delegate', () => {
    assert.equal(canonicalizePluginId('delegate_to_claude_code'), 'delegate')
  })

  it('resolves claude_code → delegate', () => {
    assert.equal(canonicalizePluginId('claude_code'), 'delegate')
  })

  it('resolves process_tool → shell', () => {
    assert.equal(canonicalizePluginId('process_tool'), 'shell')
  })

  it('resolves openclaw_browser → browser', () => {
    assert.equal(canonicalizePluginId('openclaw_browser'), 'browser')
  })

  it('returns raw string (preserving case) for empty normalized result', () => {
    // non-string input → normalizePluginId returns ''
    assert.equal(canonicalizePluginId(123), '')
  })
})

// ---------------------------------------------------------------------------
// expandPluginIds
// ---------------------------------------------------------------------------
describe('expandPluginIds', () => {
  it('shell implies process', () => {
    const result = expandPluginIds(['shell'])
    assert.ok(result.includes('shell'))
    assert.ok(result.includes('process'))
  })

  it('manage_platform expands to 10 sub-plugins', () => {
    const result = expandPluginIds(['manage_platform'])
    const expected = [
      'manage_platform',
      'manage_agents',
      'manage_projects',
      'manage_tasks',
      'manage_schedules',
      'manage_skills',
      'manage_documents',
      'manage_webhooks',
      'manage_connectors',
      'manage_sessions',
      'manage_secrets',
    ]
    for (const e of expected) {
      assert.ok(result.includes(e), `expected ${e} in expansion`)
    }
  })

  it('web expands to include web_search and web_fetch', () => {
    const result = expandPluginIds(['web'])
    assert.ok(result.includes('web'))
    assert.ok(result.includes('web_search'))
    assert.ok(result.includes('web_fetch'))
  })

  it('removes duplicates after expansion', () => {
    const result = expandPluginIds(['web', 'web_search', 'web_fetch'])
    const unique = new Set(result)
    assert.equal(result.length, unique.size)
  })

  it('returns empty array for empty input', () => {
    assert.deepEqual(expandPluginIds([]), [])
  })

  it('keeps unknown plugin as-is', () => {
    const result = expandPluginIds(['my_custom_plugin'])
    assert.ok(result.includes('my_custom_plugin'))
  })

  it('deduplicates overlapping expansions from multiple inputs', () => {
    const result = expandPluginIds(['web', 'web_search'])
    const counts = result.reduce<Record<string, number>>((acc, id) => {
      acc[id] = (acc[id] || 0) + 1
      return acc
    }, {})
    for (const [id, count] of Object.entries(counts)) {
      assert.equal(count, 1, `${id} appears ${count} times`)
    }
  })

  it('returns empty array for null', () => {
    assert.deepEqual(expandPluginIds(null), [])
  })

  it('returns empty array for undefined', () => {
    assert.deepEqual(expandPluginIds(undefined), [])
  })

  it('shell also expands aliases (execute_command, process_tool)', () => {
    const result = expandPluginIds(['shell'])
    assert.ok(result.includes('execute_command'))
    assert.ok(result.includes('process_tool'))
  })

  it('manage_platform + shell has no duplicates', () => {
    const result = expandPluginIds(['manage_platform', 'shell'])
    const unique = new Set(result)
    assert.equal(result.length, unique.size)
  })

  it('handles same plugin requested multiple times', () => {
    const result = expandPluginIds(['web', 'web', 'web'])
    const webCount = result.filter((id) => id === 'web').length
    assert.equal(webCount, 1)
  })
})

// ---------------------------------------------------------------------------
// getPluginAliases
// ---------------------------------------------------------------------------
describe('getPluginAliases', () => {
  it('web returns [web, web_search, web_fetch]', () => {
    const result = getPluginAliases('web')
    assert.ok(result.includes('web'))
    assert.ok(result.includes('web_search'))
    assert.ok(result.includes('web_fetch'))
    assert.equal(result.length, 3)
  })

  it('web_search returns the same group as web', () => {
    const fromWeb = getPluginAliases('web').sort()
    const fromAlias = getPluginAliases('web_search').sort()
    assert.deepEqual(fromWeb, fromAlias)
  })

  it('unknown plugin returns array with just the input', () => {
    assert.deepEqual(getPluginAliases('unknown_thing'), ['unknown_thing'])
  })

  it('shell includes execute_command and process_tool', () => {
    const result = getPluginAliases('shell')
    assert.ok(result.includes('shell'))
    assert.ok(result.includes('execute_command'))
    assert.ok(result.includes('process_tool'))
  })

  it('returns empty array for empty string', () => {
    assert.deepEqual(getPluginAliases(''), [])
  })

  it('returns empty array for null', () => {
    assert.deepEqual(getPluginAliases(null), [])
  })

  it('delegate group includes all delegate variants', () => {
    const result = getPluginAliases('delegate')
    assert.ok(result.includes('claude_code'))
    assert.ok(result.includes('delegate_to_claude_code'))
    assert.ok(result.includes('codex_cli'))
    assert.ok(result.includes('delegate_to_codex_cli'))
  })
})

// ---------------------------------------------------------------------------
// pluginIdMatches
// ---------------------------------------------------------------------------
describe('pluginIdMatches', () => {
  it('web enabled, web_search matches (alias)', () => {
    assert.equal(pluginIdMatches(['web'], 'web_search'), true)
  })

  it('web_search enabled, web matches (reverse alias)', () => {
    assert.equal(pluginIdMatches(['web_search'], 'web'), true)
  })

  it('files enabled, shell does not match (different families)', () => {
    assert.equal(pluginIdMatches(['files'], 'shell'), false)
  })

  it('manage_platform enabled, manage_tasks matches (implication)', () => {
    assert.equal(pluginIdMatches(['manage_platform'], 'manage_tasks'), true)
  })

  it('empty enabled list, nothing matches', () => {
    assert.equal(pluginIdMatches([], 'web'), false)
  })

  it('case insensitive match', () => {
    assert.equal(pluginIdMatches(['WEB'], 'web_search'), true)
  })

  it('shell enabled, process matches (implication)', () => {
    assert.equal(pluginIdMatches(['shell'], 'process'), true)
  })

  it('manage_platform enabled, manage_secrets matches', () => {
    assert.equal(pluginIdMatches(['manage_platform'], 'manage_secrets'), true)
  })

  it('null enabled list returns false', () => {
    assert.equal(pluginIdMatches(null, 'web'), false)
  })

  it('undefined enabled list returns false', () => {
    assert.equal(pluginIdMatches(undefined, 'web'), false)
  })
})

// ---------------------------------------------------------------------------
// Complex expansion scenarios
// ---------------------------------------------------------------------------
describe('complex expansion scenarios', () => {
  it('shell + web + memory fully expands', () => {
    const result = expandPluginIds(['shell', 'web', 'memory'])
    // shell family
    assert.ok(result.includes('shell'))
    assert.ok(result.includes('execute_command'))
    assert.ok(result.includes('process_tool'))
    assert.ok(result.includes('process'))
    // web family
    assert.ok(result.includes('web'))
    assert.ok(result.includes('web_search'))
    assert.ok(result.includes('web_fetch'))
    // memory family
    assert.ok(result.includes('memory'))
    assert.ok(result.includes('memory_tool'))
  })

  it('large plugin list (50+ items) all expanded correctly', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `custom_plugin_${i}`)
    ids.push('shell', 'web')
    const result = expandPluginIds(ids)
    // All custom ones present
    for (let i = 0; i < 50; i++) {
      assert.ok(result.includes(`custom_plugin_${i}`))
    }
    // Shell expansion present
    assert.ok(result.includes('process'))
    // Web expansion present
    assert.ok(result.includes('web_fetch'))
  })

  it('alias chains do not cause infinite loops', () => {
    // delegate has many aliases; expansion should terminate
    const result = expandPluginIds(['delegate'])
    assert.ok(result.includes('delegate'))
    assert.ok(result.includes('claude_code'))
    assert.ok(result.includes('delegate_to_claude_code'))
    // Just confirm it returned without hanging
    assert.ok(result.length > 0)
  })

  it('connector aliases expand correctly', () => {
    const result = expandPluginIds(['manage_connectors'])
    assert.ok(result.includes('manage_connectors'))
    assert.ok(result.includes('connectors'))
    assert.ok(result.includes('connector_message_tool'))
  })

  it('sandbox aliases expand', () => {
    const result = expandPluginIds(['sandbox'])
    assert.ok(result.includes('sandbox'))
    assert.ok(result.includes('sandbox_exec'))
    assert.ok(result.includes('sandbox_list_runtimes'))
  })

  it('files expands to include read_file, write_file, etc.', () => {
    const result = expandPluginIds(['files'])
    assert.ok(result.includes('read_file'))
    assert.ok(result.includes('write_file'))
    assert.ok(result.includes('list_files'))
    assert.ok(result.includes('copy_file'))
    assert.ok(result.includes('move_file'))
    assert.ok(result.includes('delete_file'))
    assert.ok(result.includes('send_file'))
  })
})
