import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildWhatsAppTextPayloads,
  buildWhatsAppInboundMessage,
  isWhatsAppSocketAlive,
  isWhatsAppInboundAllowed,
  normalizeWhatsAppAudioForSend,
  normalizeWhatsAppIdentifier,
  resolveWhatsAppAllowedIdentifiers,
} from './whatsapp'

test('buildWhatsAppTextPayloads disables link previews for text sends', () => {
  const payloads = buildWhatsAppTextPayloads('See https://example.com for details')

  assert.deepEqual(payloads, [
    { text: 'See https://example.com for details', linkPreview: null },
  ])
})

test('buildWhatsAppTextPayloads chunks long messages and disables previews for each chunk', () => {
  const payloads = buildWhatsAppTextPayloads('x'.repeat(4500))

  assert.equal(payloads.length, 2)
  assert.equal(payloads[0].text.length, 4000)
  assert.equal(payloads[1].text.length, 500)
  assert.equal(payloads[0].linkPreview, null)
  assert.equal(payloads[1].linkPreview, null)
})

test('normalizeWhatsAppIdentifier strips jid wrappers and device suffixes', () => {
  assert.equal(normalizeWhatsAppIdentifier('+1 (555) 000-1111@s.whatsapp.net'), '15550001111')
  assert.equal(normalizeWhatsAppIdentifier('15550001111:7@s.whatsapp.net'), '15550001111')
  assert.equal(normalizeWhatsAppIdentifier('199900000001@lid'), '199900000001')
})

test('isWhatsAppInboundAllowed matches allow-list entries against alt phone JIDs', () => {
  const allowed = ['15550001111']
  const msg = {
    key: {
      remoteJid: '199900000001@lid',
      remoteJidAlt: '15550001111@s.whatsapp.net',
    },
  } as any

  assert.equal(isWhatsAppInboundAllowed({ allowedJids: allowed, msg }), true)
  assert.equal(isWhatsAppInboundAllowed({ allowedJids: ['15559990000'], msg }), false)
})

test('resolveWhatsAppAllowedIdentifiers merges connector and settings approvals', () => {
  const allowed = resolveWhatsAppAllowedIdentifiers({
    configuredAllowedJids: '15550001111',
    settingsContacts: [
      { id: 'family', label: 'Family', phone: '+1 (666) 000-2222' },
      { id: 'dup', label: 'Family JID', phone: '16660002222@s.whatsapp.net' },
    ],
  })

  assert.deepEqual(allowed, ['15550001111', '16660002222'])
})

test('resolveWhatsAppAllowedIdentifiers keeps the connector open when no allowedJids are configured', () => {
  const allowed = resolveWhatsAppAllowedIdentifiers({
    settingsContacts: [
      { id: 'family', label: 'Family', phone: '+1 (666) 000-2222' },
    ],
  })

  assert.equal(allowed, null)
})

test('buildWhatsAppInboundMessage includes modern WhatsApp metadata', () => {
  const inbound = buildWhatsAppInboundMessage({
    msg: {
      key: {
        remoteJid: '199900000001@lid',
        remoteJidAlt: '15550001111@s.whatsapp.net',
        id: 'wamid-1',
      },
      pushName: 'Alice',
      message: {
        extendedTextMessage: {
          text: 'Hey there',
          contextInfo: {
            stanzaId: 'quoted-1',
            mentionedJid: ['bot@s.whatsapp.net'],
          },
        },
      },
    } as any,
    selfJids: ['bot@s.whatsapp.net'],
  })

  assert.ok(inbound)
  assert.equal(inbound?.channelId, '199900000001@lid')
  assert.equal(inbound?.channelIdAlt, '15550001111@s.whatsapp.net')
  assert.equal(inbound?.senderId, '199900000001@lid')
  assert.equal(inbound?.senderIdAlt, '15550001111@s.whatsapp.net')
  assert.equal(inbound?.messageId, 'wamid-1')
  assert.equal(inbound?.replyToMessageId, 'quoted-1')
  assert.equal(inbound?.mentionsBot, true)
  assert.equal(inbound?.isGroup, false)
  assert.equal(inbound?.text, 'Hey there')
})

test('isWhatsAppSocketAlive reports disconnected sockets as dead so daemon restarts can run', () => {
  assert.equal(isWhatsAppSocketAlive({
    stopped: false,
    socket: { ws: { isClosed: true } },
    connectionState: 'close',
  }), false)

  assert.equal(isWhatsAppSocketAlive({
    stopped: false,
    socket: { ws: { isClosing: true } },
    connectionState: 'connecting',
  }), false)
})

test('isWhatsAppSocketAlive keeps QR and active sessions marked live', () => {
  assert.equal(isWhatsAppSocketAlive({
    stopped: false,
    socket: { ws: { isConnecting: true } },
    connectionState: 'connecting',
  }), true)

  assert.equal(isWhatsAppSocketAlive({
    stopped: false,
    socket: { ws: { isOpen: true } },
    connectionState: 'open',
  }), true)
})

test('normalizeWhatsAppAudioForSend transcodes mp3 voice notes to Android-safe opus/ogg', () => {
  let transcodeCalls = 0
  const converted = normalizeWhatsAppAudioForSend({
    buffer: Buffer.from('mp3-audio'),
    mimeType: 'audio/mpeg',
    fileName: 'voice-note.mp3',
    ptt: true,
    transcode: ({ buffer, mimeType, fileName }) => {
      transcodeCalls += 1
      assert.equal(buffer.toString(), 'mp3-audio')
      assert.equal(mimeType, 'audio/mpeg')
      assert.equal(fileName, 'voice-note.mp3')
      return {
        buffer: Buffer.from('ogg-opus-audio'),
        mimeType: 'audio/ogg; codecs=opus',
      }
    },
  })

  assert.equal(transcodeCalls, 1)
  assert.equal(converted.buffer.toString(), 'ogg-opus-audio')
  assert.equal(converted.mimeType, 'audio/ogg; codecs=opus')
})

test('normalizeWhatsAppAudioForSend keeps existing ogg voice notes unchanged', () => {
  const converted = normalizeWhatsAppAudioForSend({
    buffer: Buffer.from('already-ogg'),
    mimeType: 'audio/ogg',
    fileName: 'voice-note.ogg',
    ptt: true,
    transcode: () => {
      throw new Error('transcode should not be called')
    },
  })

  assert.equal(converted.buffer.toString(), 'already-ogg')
  assert.equal(converted.mimeType, 'audio/ogg; codecs=opus')
})

test('normalizeWhatsAppAudioForSend leaves normal audio attachments alone when ptt is disabled', () => {
  const converted = normalizeWhatsAppAudioForSend({
    buffer: Buffer.from('music'),
    mimeType: 'audio/mpeg',
    fileName: 'music.mp3',
    ptt: false,
    transcode: () => {
      throw new Error('transcode should not be called')
    },
  })

  assert.equal(converted.buffer.toString(), 'music')
  assert.equal(converted.mimeType, 'audio/mpeg')
})
