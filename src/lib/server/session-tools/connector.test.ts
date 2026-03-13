import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildConnectorTurnReplayKey,
  CONNECTOR_MESSAGE_TOOL_ACTIONS,
  CONNECTOR_MESSAGE_TOOL_PARAMETERS,
  inferConnectorActionName,
  normalizeConnectorActionInputAliases,
  normalizeConnectorActionName,
  resolveConnectorVoiceId,
} from './connector'
import { getPluginManager } from '../plugins'
import { buildSessionTools } from './index'

describe('connector_message_tool contract', () => {
  it('exposes the connector actions and voice-note fields through the plugin schema', () => {
    const entry = getPluginManager()
      .getTools(['manage_connectors'])
      .find((tool) => tool.tool.name === 'connector_message_tool')

    assert.ok(entry, 'connector_message_tool should be registered for manage_connectors')

    const props = (entry!.tool.parameters?.properties ?? {}) as Record<string, { type?: string; enum?: string[] }>
    assert.deepEqual(props.action?.enum, [...CONNECTOR_MESSAGE_TOOL_ACTIONS])
    assert.equal(props.approved?.type, 'boolean')
    assert.equal(props.ptt?.type, 'boolean')
    assert.equal(props.voiceText?.type, 'string')
    assert.equal(props.recipientId?.type, 'string')
    assert.equal(props.channel?.type, 'string')
    assert.equal(Array.isArray(entry!.tool.parameters?.required), false)
    assert.equal(Array.isArray((CONNECTOR_MESSAGE_TOOL_PARAMETERS as { required?: unknown }).required), false)
  })

  it('normalizes legacy rich-message aliases to the current connector actions', () => {
    assert.equal(normalizeConnectorActionName('message_react'), 'react')
    assert.equal(normalizeConnectorActionName('message_edit'), 'edit')
    assert.equal(normalizeConnectorActionName('message_delete'), 'delete')
    assert.equal(normalizeConnectorActionName('message_pin'), 'pin')
    assert.equal(normalizeConnectorActionName('send_voice_note'), 'send_voice_note')
  })

  it('infers send-style actions from partial connector payloads', () => {
    assert.equal(inferConnectorActionName({ voiceText: 'hello there' }), 'send_voice_note')
    assert.equal(inferConnectorActionName({ followUpMessage: 'check back later', delaySec: 60 }), 'schedule_followup')
    assert.equal(inferConnectorActionName({ message: 'plain text message' }), 'send')
    assert.equal(inferConnectorActionName({}), null)
  })

  it('normalizes connector and target aliases from model-generated delivery calls', () => {
    const running = [{ id: 'd81cd63b', name: 'Main Whatsapp connection' }]

    assert.deepEqual(
      normalizeConnectorActionInputAliases({
        action: 'send_voice_note',
        channel: 'Main Whatsapp connection',
        recipientId: '07958148127',
      }, running),
      {
        action: 'send_voice_note',
        channel: 'Main Whatsapp connection',
        recipientId: '07958148127',
        connectorId: 'd81cd63b',
        to: '07958148127',
      },
    )

    assert.deepEqual(
      normalizeConnectorActionInputAliases({
        action: 'send_voice_note',
        id: 'd81cd63b',
        target: '199900000001@lid',
      }, running),
      {
        action: 'send_voice_note',
        id: 'd81cd63b',
        target: '199900000001@lid',
        connectorId: 'd81cd63b',
        to: '199900000001@lid',
      },
    )
  })

  it('inherits the current agent ElevenLabs voice for connector voice notes when no explicit voiceId is passed', () => {
    assert.equal(
      resolveConnectorVoiceId({
        sessionAgentId: 'agent-1',
        getAgent: (id) => id === 'agent-1' ? { elevenLabsVoiceId: 'agent-voice-123' } : null,
      }),
      'agent-voice-123',
    )

    assert.equal(
      resolveConnectorVoiceId({
        explicitVoiceId: 'tool-voice-999',
        sessionAgentId: 'agent-1',
        getAgent: () => ({ elevenLabsVoiceId: 'agent-voice-123' }),
      }),
      'tool-voice-999',
    )

    assert.equal(
      resolveConnectorVoiceId({
        sessionAgentId: 'agent-1',
        getAgent: () => ({ elevenLabsVoiceId: '   ' }),
      }),
      undefined,
    )
  })

  it('uses a distinct same-turn replay key for different recipients and actions', () => {
    const base = {
      turnKey: 'session-1|1234',
      connectorId: 'conn-1',
      message: 'hello',
    }

    const lindaSend = buildConnectorTurnReplayKey({
      ...base,
      actionName: 'send_voice_note',
      channelId: '27822644571@s.whatsapp.net',
      voiceText: 'hello linda',
    })
    const carmenSend = buildConnectorTurnReplayKey({
      ...base,
      actionName: 'send_voice_note',
      channelId: '27848402416@s.whatsapp.net',
      voiceText: 'hello linda',
    })
    const lindaText = buildConnectorTurnReplayKey({
      ...base,
      actionName: 'send',
      channelId: '27822644571@s.whatsapp.net',
      message: 'plain text',
    })

    assert.notEqual(lindaSend, carmenSend)
    assert.notEqual(lindaSend, lindaText)
  })

  it('treats raw id as messageId for message actions instead of as a target alias', () => {
    assert.deepEqual(
      normalizeConnectorActionInputAliases({
        action: 'react',
        id: 'msg-123',
        emoji: '👍',
      }, [{ id: 'conn-1', name: 'Primary connector' }]),
      {
        action: 'react',
        id: 'msg-123',
        emoji: '👍',
        messageId: 'msg-123',
      },
    )
  })

  it('buildSessionTools exposes the native connector schema instead of the legacy passthrough bridge', async () => {
    const built = await buildSessionTools(process.cwd(), ['manage_connectors'], {
      sessionId: 'connector-native-schema-test',
      agentId: 'default',
      platformAssignScope: 'self',
    })

    try {
      const connectorTool = built.tools.find((tool) => tool.name === 'connector_message_tool')
      assert.ok(connectorTool, 'connector_message_tool should be available when manage_connectors is enabled')

      const schema = (connectorTool as { schema?: { safeParse: (value: unknown) => { success: boolean } } }).schema
      assert.ok(schema, 'connector_message_tool should expose a validation schema')
      assert.equal(schema.safeParse({ action: 'send_voice_note', approved: true, ptt: true }).success, true)
      assert.equal(schema.safeParse({ voiceText: 'hello', recipientId: '07958148127', channel: 'Main Whatsapp connection' }).success, true)
      assert.equal(schema.safeParse({ action: 'message_react' }).success, true)
      assert.equal(schema.safeParse({}).success, true)
      assert.equal(schema.safeParse({ action: 'bogus_action' }).success, false)
    } finally {
      await built.cleanup()
    }
  })

  it('loads connector_message_tool when a session only has the tool-level grant alias', async () => {
    const built = await buildSessionTools(process.cwd(), ['connector_message_tool'], {
      sessionId: 'connector-tool-alias-test',
      agentId: 'default',
      platformAssignScope: 'self',
    })

    try {
      assert.equal(
        built.tools.some((tool) => tool.name === 'connector_message_tool'),
        true,
        'connector_message_tool should load from its persisted approval alias',
      )
    } finally {
      await built.cleanup()
    }
  })
})
