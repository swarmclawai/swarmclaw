import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getPluginManager } from './plugins'
import { getEnabledToolPlanningView, getToolsForCapability, TOOL_CAPABILITY } from './tool-planning'

let seq = 0

function uniquePluginId(prefix: string): string {
  seq += 1
  return `${prefix}_${Date.now()}_${seq}`
}

describe('tool-planning', () => {
  it('collects core planning metadata for aliased built-in tools', () => {
    const view = getEnabledToolPlanningView(['web_search', 'web_fetch', 'browser', 'manage_connectors'])

    assert.deepEqual(view.displayToolIds, ['browser', 'manage_connectors', 'web'])
    assert.deepEqual(getToolsForCapability(['web_search'], TOOL_CAPABILITY.researchSearch), ['web_search'])
    assert.deepEqual(getToolsForCapability(['manage_connectors'], TOOL_CAPABILITY.deliveryVoiceNote), ['connector_message_tool'])
  })

  it('collects planning metadata from custom plugin tools', () => {
    const pluginId = uniquePluginId('planner_plugin')
    getPluginManager().registerBuiltin(pluginId, {
      name: 'Planner Plugin',
      tools: [
        {
          name: 'custom_media_sender',
          description: 'Send rendered media somewhere special.',
          planning: {
            capabilities: ['delivery.media', 'delivery.voice_note'],
            disciplineGuidance: ['Use `custom_media_sender` for bespoke outbound media delivery.'],
          },
          parameters: { type: 'object', properties: {} },
          execute: async () => 'ok',
        },
      ],
    })

    const view = getEnabledToolPlanningView([pluginId])
    assert.deepEqual(getToolsForCapability([pluginId], TOOL_CAPABILITY.deliveryMedia), ['custom_media_sender'])
    assert.equal(view.disciplineGuidance.includes('Use `custom_media_sender` for bespoke outbound media delivery.'), true)
  })
})
