import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getPlatform, isNoMessage, formatMediaLine, formatInboundUserText, extractEmbeddedMedia, selectOutboundMediaFiles } from './manager'
import { handleSignalEvent } from './signal'
import type { PlatformConnector } from './types'
import type { InboundMessage, InboundMedia } from './types'
import fs from 'node:fs'
import path from 'node:path'
import { UPLOAD_DIR } from '../storage'

// ---------------------------------------------------------------------------
// 1. Connector module resolution (getPlatform)
// ---------------------------------------------------------------------------
describe('getPlatform — connector module resolution', () => {
  const newPlatforms = ['matrix', 'googlechat', 'teams', 'signal', 'bluebubbles'] as const

  for (const name of newPlatforms) {
    it(`returns a valid module for "${name}"`, async () => {
      const mod = await getPlatform(name)
      assert.ok(mod, `getPlatform("${name}") should return a module`)
    })

    it(`"${name}" module has a start function (PlatformConnector)`, async () => {
      const mod: PlatformConnector = await getPlatform(name)
      assert.equal(typeof mod.start, 'function')
    })
  }

  // Legacy platforms still resolve
  for (const name of ['discord', 'telegram', 'slack', 'whatsapp', 'openclaw'] as const) {
    it(`resolves legacy platform "${name}"`, async () => {
      const mod = await getPlatform(name)
      assert.equal(typeof mod.start, 'function')
    })
  }

  it('throws on unknown platform', async () => {
    await assert.rejects(() => getPlatform('nonexistent'), {
      message: 'Unknown platform: nonexistent',
    })
  })
})

// ---------------------------------------------------------------------------
// 2. Signal — handleSignalEvent message parsing
// ---------------------------------------------------------------------------
describe('handleSignalEvent — Signal stdio message parsing', () => {
  function makeFakeConnector() {
    return {
      id: 'sig-test',
      name: 'Signal Test',
      platform: 'signal',
      agentId: 'agent-1',
      credentialId: null,
      config: { phoneNumber: '+15551234567', signalCliPath: 'signal-cli', signalCliMode: 'http' },
      isEnabled: true,
      status: 'running' as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as any
  }

  it('parses envelope with dataMessage.message field', async () => {
    const received: InboundMessage[] = []
    const connector = makeFakeConnector()
    const event = {
      envelope: {
        source: '+15559876543',
        sourceName: 'Alice',
        dataMessage: { message: 'Hello from Signal' },
      },
    }
    await handleSignalEvent(event, connector, async (msg) => {
      received.push(msg)
      return 'NO_MESSAGE'
    })
    assert.equal(received.length, 1)
    assert.equal(received[0].text, 'Hello from Signal')
    assert.equal(received[0].senderId, '+15559876543')
    assert.equal(received[0].senderName, 'Alice')
    assert.equal(received[0].platform, 'signal')
    assert.equal(received[0].channelId, '+15559876543') // DM uses sender as channel
  })

  it('parses envelope with dataMessage.body field', async () => {
    const received: InboundMessage[] = []
    const connector = makeFakeConnector()
    const event = {
      envelope: {
        source: '+15550001111',
        sourceName: 'Bob',
        dataMessage: { body: 'Body variant' },
      },
    }
    await handleSignalEvent(event, connector, async (msg) => {
      received.push(msg)
      return 'NO_MESSAGE'
    })
    assert.equal(received.length, 1)
    assert.equal(received[0].text, 'Body variant')
  })

  it('uses groupId as channelId when present', async () => {
    const received: InboundMessage[] = []
    const connector = makeFakeConnector()
    const event = {
      envelope: {
        source: '+15550001111',
        sourceName: 'Carol',
        dataMessage: {
          message: 'Group msg',
          groupInfo: { groupId: 'grp-abc123' },
        },
      },
    }
    await handleSignalEvent(event, connector, async (msg) => {
      received.push(msg)
      return 'NO_MESSAGE'
    })
    assert.equal(received[0].channelId, 'grp-abc123')
    assert.equal(received[0].channelName, 'group:grp-abc123')
  })

  it('handles flat event without .envelope wrapper', async () => {
    const received: InboundMessage[] = []
    const connector = makeFakeConnector()
    // signal-cli can emit flat objects (envelope IS the top-level)
    const event = {
      source: '+15552222222',
      sourceName: 'Dave',
      dataMessage: { message: 'Flat format' },
    }
    await handleSignalEvent(event, connector, async (msg) => {
      received.push(msg)
      return 'NO_MESSAGE'
    })
    assert.equal(received.length, 1)
    assert.equal(received[0].text, 'Flat format')
    assert.equal(received[0].senderId, '+15552222222')
  })

  it('ignores events without dataMessage', async () => {
    const received: InboundMessage[] = []
    const connector = makeFakeConnector()
    // Typing indicator — no dataMessage
    const event = { envelope: { source: '+15551111111', typingMessage: { action: 'STARTED' } } }
    await handleSignalEvent(event, connector, async (msg) => {
      received.push(msg)
      return 'ok'
    })
    assert.equal(received.length, 0)
  })

  it('ignores events where dataMessage has no message or body', async () => {
    const received: InboundMessage[] = []
    const connector = makeFakeConnector()
    // Receipt with empty dataMessage
    const event = { envelope: { source: '+15551111111', dataMessage: {} } }
    await handleSignalEvent(event, connector, async (msg) => {
      received.push(msg)
      return 'ok'
    })
    assert.equal(received.length, 0)
  })
})

// ---------------------------------------------------------------------------
// 3. isNoMessage helper
// ---------------------------------------------------------------------------
describe('isNoMessage', () => {
  it('matches exact sentinel', () => {
    assert.ok(isNoMessage('NO_MESSAGE'))
  })
  it('matches case-insensitive', () => {
    assert.ok(isNoMessage('no_message'))
    assert.ok(isNoMessage('No_Message'))
  })
  it('trims whitespace', () => {
    assert.ok(isNoMessage('  NO_MESSAGE  \n'))
  })
  it('rejects non-sentinel text', () => {
    assert.ok(!isNoMessage('hello'))
    assert.ok(!isNoMessage('NO_MESSAGE extra'))
  })
})

// ---------------------------------------------------------------------------
// 4. formatMediaLine
// ---------------------------------------------------------------------------
describe('formatMediaLine', () => {
  it('formats media with URL', () => {
    const media: InboundMedia = { type: 'image', fileName: 'photo.jpg', sizeBytes: 2048, url: '/uploads/photo.jpg' }
    const line = formatMediaLine(media)
    assert.equal(line, '- IMAGE: photo.jpg (2 KB) -> /uploads/photo.jpg')
  })

  it('formats media without URL', () => {
    const media: InboundMedia = { type: 'document', mimeType: 'application/pdf', sizeBytes: 512 }
    const line = formatMediaLine(media)
    assert.equal(line, '- DOCUMENT: application/pdf (1 KB)')
  })

  it('falls back to "attachment" when no fileName or mimeType', () => {
    const media: InboundMedia = { type: 'file' }
    const line = formatMediaLine(media)
    assert.equal(line, '- FILE: attachment')
  })
})

// ---------------------------------------------------------------------------
// 5. formatInboundUserText
// ---------------------------------------------------------------------------
describe('formatInboundUserText', () => {
  it('formats basic text message', () => {
    const msg = { platform: 'signal', channelId: 'ch1', senderId: 's1', senderName: 'Alice', text: 'Hello' } as InboundMessage
    assert.equal(formatInboundUserText(msg), '[Alice] Hello')
  })

  it('handles empty text with just sender name', () => {
    const msg = { platform: 'signal', channelId: 'ch1', senderId: 's1', senderName: 'Bob', text: '' } as InboundMessage
    assert.equal(formatInboundUserText(msg), '[Bob]')
  })

  it('appends media lines', () => {
    const msg: InboundMessage = {
      platform: 'signal', channelId: 'ch1', senderId: 's1', senderName: 'Eve', text: 'Check this',
      media: [{ type: 'image', fileName: 'cat.png', url: '/cat.png' }],
    }
    const result = formatInboundUserText(msg)
    assert.ok(result.includes('[Eve] Check this'))
    assert.ok(result.includes('Media received:'))
    assert.ok(result.includes('- IMAGE: cat.png'))
  })

  it('truncates media list at 6 with overflow note', () => {
    const media: InboundMedia[] = Array.from({ length: 8 }, (_, i) => ({
      type: 'file' as const, fileName: `f${i}.txt`,
    }))
    const msg: InboundMessage = {
      platform: 'signal', channelId: 'ch1', senderId: 's1', senderName: 'Fran', text: 'files',
      media,
    }
    const result = formatInboundUserText(msg)
    assert.ok(result.includes('...and 2 more attachment(s)'))
  })
})

// ---------------------------------------------------------------------------
// 6. extractEmbeddedMedia
// ---------------------------------------------------------------------------
describe('extractEmbeddedMedia', () => {
  it('extracts markdown image and file links for uploaded assets', async () => {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true })
    const token = `test-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
    const imgName = `${token}-foo.png`
    const pdfName = `${token}-report.pdf`
    const img = path.join(UPLOAD_DIR, imgName)
    const pdf = path.join(UPLOAD_DIR, pdfName)
    fs.writeFileSync(img, 'img')
    fs.writeFileSync(pdf, 'pdf')

    try {
      const input = [
        'Here you go:',
        `![chart](/api/uploads/${imgName})`,
        `[Report](/api/uploads/${pdfName})`,
      ].join('\n')

      const out = extractEmbeddedMedia(input)
      assert.equal(out.files.length, 2)
      assert.equal(out.files[0].path, img)
      assert.equal(out.files[0].alt, 'chart')
      assert.equal(out.files[1].path, pdf)
      assert.equal(out.files[1].alt, 'Report')
      assert.equal(out.cleanText, 'Here you go:')
    } finally {
      fs.rmSync(img, { force: true })
      fs.rmSync(pdf, { force: true })
    }
  })

  it('extracts bare /api/uploads URLs and de-duplicates duplicate references', async () => {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true })
    const token = `test-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
    const pdfName = `${token}-duplicate.pdf`
    const pdf = path.join(UPLOAD_DIR, pdfName)
    fs.writeFileSync(pdf, 'pdf')
    try {
      const input = [
        `File: /api/uploads/${pdfName}`,
        `[Again](/api/uploads/${pdfName})`,
      ].join('\n')
      const out = extractEmbeddedMedia(input)
      assert.equal(out.files.length, 1)
      assert.equal(out.files[0].path, pdf)
      assert.equal(out.cleanText, 'File:')
    } finally {
      fs.rmSync(pdf, { force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// 7. selectOutboundMediaFiles
// ---------------------------------------------------------------------------
describe('selectOutboundMediaFiles', () => {
  it('deduplicates browser/screenshot variants and selects one file by default', () => {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true })
    const ts = Date.now()
    const browserPng = path.join(UPLOAD_DIR, `browser-${ts}.png`)
    const screenshotPng = path.join(UPLOAD_DIR, `screenshot-${ts + 1}.png`)
    const finalPng = path.join(UPLOAD_DIR, `${Date.now()}-wikipedia_screenshot.png`)
    fs.writeFileSync(browserPng, 'browser')
    fs.writeFileSync(screenshotPng, 'shot')
    fs.writeFileSync(finalPng, 'final')
    try {
      const selected = selectOutboundMediaFiles(
        [
          { path: browserPng, alt: 'Screenshot' },
          { path: screenshotPng, alt: 'Screenshot' },
          { path: finalPng, alt: 'wikipedia_screenshot.png' },
        ],
        'Can you send me a screenshot of Wikipedia?',
      )
      assert.equal(selected.length, 1)
      assert.equal(selected[0].path, finalPng)
    } finally {
      fs.rmSync(browserPng, { force: true })
      fs.rmSync(screenshotPng, { force: true })
      fs.rmSync(finalPng, { force: true })
    }
  })

  it('allows multiple files only when the user explicitly asks for many', () => {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true })
    const ts = Date.now()
    const browserPng = path.join(UPLOAD_DIR, `browser-${ts}.png`)
    const screenshotPng = path.join(UPLOAD_DIR, `screenshot-${ts + 1}.png`)
    const pdf = path.join(UPLOAD_DIR, `${Date.now()}-report.pdf`)
    fs.writeFileSync(browserPng, 'browser')
    fs.writeFileSync(screenshotPng, 'shot')
    fs.writeFileSync(pdf, 'pdf')
    try {
      const selected = selectOutboundMediaFiles(
        [
          { path: browserPng, alt: 'Screenshot' },
          { path: screenshotPng, alt: 'Screenshot' },
          { path: pdf, alt: 'Report' },
        ],
        'Send both screenshots and the PDF',
      )
      assert.equal(selected.length, 2)
      assert.deepEqual(selected.map((f) => path.basename(f.path)).sort(), [path.basename(browserPng), path.basename(pdf)].sort())
    } finally {
      fs.rmSync(browserPng, { force: true })
      fs.rmSync(screenshotPng, { force: true })
      fs.rmSync(pdf, { force: true })
    }
  })
})
