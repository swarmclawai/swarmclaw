import { spawn, execSync } from 'child_process'
import type { ChildProcess } from 'child_process'
import type { Connector } from '@/types'
import type { PlatformConnector, ConnectorInstance, InboundMessage } from './types'
import { isNoMessage } from './manager'

const signal: PlatformConnector = {
  async start(connector, _botToken, onMessage): Promise<ConnectorInstance> {
    const phoneNumber = connector.config.phoneNumber
    if (!phoneNumber) throw new Error('Missing phoneNumber in connector config')

    const cliPath = connector.config.signalCliPath || 'signal-cli'
    const mode = connector.config.signalCliMode || 'stdio'
    const httpUrl = connector.config.signalCliHttpUrl || 'http://localhost:8080'

    let stopped = false
    let daemonProc: ChildProcess | null = null
    let pollTimer: ReturnType<typeof setInterval> | null = null

    if (mode === 'stdio') {
      // Spawn signal-cli in daemon mode with JSON output
      daemonProc = spawn(cliPath, ['-u', phoneNumber, 'daemon', '--json'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let buffer = ''

      daemonProc.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const event = JSON.parse(line)
            handleSignalEvent(event, connector, onMessage)
          } catch {
            // Not valid JSON, skip
          }
        }
      })

      daemonProc.stderr?.on('data', (chunk: Buffer) => {
        const msg = chunk.toString().trim()
        if (msg) console.error(`[signal] stderr: ${msg}`)
      })

      daemonProc.on('exit', (code) => {
        if (!stopped) {
          console.error(`[signal] daemon exited unexpectedly with code ${code}`)
        }
      })

      console.log(`[signal] Daemon started in stdio mode for ${phoneNumber}`)
    } else if (mode === 'http') {
      // Poll the signal-cli REST API for incoming messages
      const pollInterval = 2000

      const poll = async () => {
        if (stopped) return
        try {
          const res = await fetch(`${httpUrl}/v1/receive/${phoneNumber}`)
          if (!res.ok) return
          const messages = await res.json()
          if (Array.isArray(messages)) {
            for (const event of messages) {
              handleSignalEvent(event, connector, onMessage)
            }
          }
        } catch {
          // Silently retry on connection errors
        }
      }

      pollTimer = setInterval(poll, pollInterval)
      console.log(`[signal] Polling ${httpUrl} for ${phoneNumber} every ${pollInterval}ms`)
    } else {
      throw new Error(`Unknown signalCliMode: ${mode}. Use 'stdio' or 'http'.`)
    }

    return {
      connector,
      async sendMessage(channelId, text) {
        if (stopped) throw new Error('Connector is stopped')

        if (mode === 'http') {
          const res = await fetch(`${httpUrl}/v2/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: text,
              number: phoneNumber,
              recipients: [channelId],
            }),
          })
          if (!res.ok) {
            throw new Error(`Signal HTTP send failed: ${res.status} ${res.statusText}`)
          }
        } else {
          // Use signal-cli send command
          try {
            execSync(
              `${cliPath} -u ${phoneNumber} send -m ${JSON.stringify(text)} ${channelId}`,
              { timeout: 15_000 },
            )
          } catch (err: any) {
            throw new Error(`Signal send failed: ${err.message}`)
          }
        }
      },
      async stop() {
        stopped = true
        if (pollTimer) {
          clearInterval(pollTimer)
          pollTimer = null
        }
        if (daemonProc) {
          daemonProc.kill('SIGTERM')
          daemonProc = null
        }
        console.log(`[signal] Connector stopped for ${phoneNumber}`)
      },
    }
  },
}

/** Parse a signal-cli JSON event and route it as an inbound message */
export async function handleSignalEvent(
  event: any,
  connector: Connector,
  onMessage: (msg: InboundMessage) => Promise<string>,
) {
  // signal-cli JSON output structure varies; handle the common envelope format
  const envelope = event.envelope || event
  const dataMessage = envelope.dataMessage
  if (!dataMessage?.message && !dataMessage?.body) return

  const sender = envelope.source || envelope.sourceNumber || ''
  const text = dataMessage.message || dataMessage.body || ''
  const groupId = dataMessage.groupInfo?.groupId || null

  const inbound: InboundMessage = {
    platform: 'signal',
    channelId: groupId || sender,
    channelName: groupId ? `group:${groupId}` : sender,
    senderId: sender,
    senderName: envelope.sourceName || sender,
    text,
  }

  try {
    const response = await onMessage(inbound)
    if (isNoMessage(response)) return

    // Send reply back
    const cliPath = connector.config.signalCliPath || 'signal-cli'
    const phoneNumber = connector.config.phoneNumber
    const mode = connector.config.signalCliMode || 'stdio'
    const httpUrl = connector.config.signalCliHttpUrl || 'http://localhost:8080'

    if (mode === 'http') {
      await fetch(`${httpUrl}/v2/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: response,
          number: phoneNumber,
          recipients: [inbound.channelId],
        }),
      })
    } else {
      execSync(
        `${cliPath} -u ${phoneNumber} send -m ${JSON.stringify(response)} ${inbound.channelId}`,
        { timeout: 15_000 },
      )
    }
  } catch (err: any) {
    console.error(`[signal] Error handling message:`, err.message)
  }
}

export default signal
