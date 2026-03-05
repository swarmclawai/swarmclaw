import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import type { Plugin, PluginHooks } from '@/types'
import { getPluginManager } from '../plugins'
import { normalizeToolInputArgs } from './normalize-tool-args'
import { loadSettings } from '../storage'
import type { ToolBuildContext } from './context'

interface SmtpConfig {
  host: string
  port: number
  secure: boolean
  username: string
  password: string
  fromAddress: string
  fromName: string
}

function getSmtpConfig(): SmtpConfig {
  const settings = loadSettings()
  const ps = (settings.pluginSettings as Record<string, Record<string, unknown>> | undefined)?.email ?? {}
  return {
    host: (ps.host as string) || '',
    port: Number(ps.port) || 587,
    secure: ps.secure === true || ps.secure === 'true',
    username: (ps.username as string) || '',
    password: (ps.password as string) || '',
    fromAddress: (ps.fromAddress as string) || '',
    fromName: (ps.fromName as string) || 'SwarmClaw Agent',
  }
}

/**
 * Minimal SMTP client using raw sockets.
 * Avoids nodemailer dependency — uses Node's built-in net/tls.
 */
async function sendSmtpEmail(cfg: SmtpConfig, to: string[], subject: string, body: string, html?: string): Promise<string> {
  const net = await import('net')
  const tls = await import('tls')

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('SMTP timeout (30s)')), 30_000)
    let socket: import('net').Socket
    const lines: string[] = []
    let phase = 'connect'

    const cleanup = () => { clearTimeout(timeout); try { socket.destroy() } catch { /* ok */ } }

    const readLine = (data: Buffer) => {
      const text = data.toString()
      lines.push(text)
      const code = parseInt(text.slice(0, 3), 10)
      return { text, code }
    }

    const send = (cmd: string) => { socket.write(cmd + '\r\n') }

    // Build MIME message
    const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const date = new Date().toUTCString()
    const msgId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@${cfg.host}>`
    const toHeader = to.join(', ')

    let message = `From: ${cfg.fromName ? `"${cfg.fromName}" ` : ''}<${cfg.fromAddress}>\r\n`
    message += `To: ${toHeader}\r\n`
    message += `Subject: ${subject}\r\n`
    message += `Date: ${date}\r\n`
    message += `Message-ID: ${msgId}\r\n`
    message += `MIME-Version: 1.0\r\n`

    if (html) {
      message += `Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n`
      message += `--${boundary}\r\n`
      message += `Content-Type: text/plain; charset=utf-8\r\n\r\n`
      message += body + '\r\n'
      message += `--${boundary}\r\n`
      message += `Content-Type: text/html; charset=utf-8\r\n\r\n`
      message += html + '\r\n'
      message += `--${boundary}--\r\n`
    } else {
      message += `Content-Type: text/plain; charset=utf-8\r\n\r\n`
      message += body + '\r\n'
    }

    const connectOpts = { host: cfg.host, port: cfg.port }

    const handleData = (data: Buffer) => {
      const { code } = readLine(data)

      switch (phase) {
        case 'connect':
          if (code === 220) { phase = 'ehlo'; send(`EHLO ${cfg.host}`) }
          else { cleanup(); reject(new Error(`SMTP connect failed: ${data.toString().trim()}`)) }
          break
        case 'ehlo':
          if (code === 250) {
            if (cfg.secure && !('encrypted' in socket)) {
              phase = 'starttls'; send('STARTTLS')
            } else if (cfg.username) {
              phase = 'auth'; send('AUTH LOGIN')
            } else {
              phase = 'mail_from'; send(`MAIL FROM:<${cfg.fromAddress}>`)
            }
          }
          break
        case 'starttls':
          if (code === 220) {
            const tlsSocket = tls.connect({ socket, host: cfg.host, rejectUnauthorized: false }, () => {
              socket = tlsSocket as unknown as import('net').Socket
              socket.on('data', handleData)
              phase = 'ehlo2'; send(`EHLO ${cfg.host}`)
            })
            tlsSocket.on('error', (err: Error) => { cleanup(); reject(err) })
          }
          break
        case 'ehlo2':
          if (code === 250) {
            if (cfg.username) { phase = 'auth'; send('AUTH LOGIN') }
            else { phase = 'mail_from'; send(`MAIL FROM:<${cfg.fromAddress}>`) }
          }
          break
        case 'auth':
          if (code === 334) { phase = 'auth_user'; send(Buffer.from(cfg.username).toString('base64')) }
          else { cleanup(); reject(new Error(`SMTP AUTH failed: ${data.toString().trim()}`)) }
          break
        case 'auth_user':
          if (code === 334) { phase = 'auth_pass'; send(Buffer.from(cfg.password).toString('base64')) }
          break
        case 'auth_pass':
          if (code === 235) { phase = 'mail_from'; send(`MAIL FROM:<${cfg.fromAddress}>`) }
          else { cleanup(); reject(new Error(`SMTP auth failed: ${data.toString().trim()}`)) }
          break
        case 'mail_from':
          if (code === 250) { phase = 'rcpt_to'; send(`RCPT TO:<${to[0]}>`) }
          break
        case 'rcpt_to':
          if (code === 250) { phase = 'data'; send('DATA') }
          else { cleanup(); reject(new Error(`SMTP RCPT rejected: ${data.toString().trim()}`)) }
          break
        case 'data':
          if (code === 354) { phase = 'message'; send(message + '\r\n.') }
          break
        case 'message':
          if (code === 250) { phase = 'quit'; send('QUIT'); cleanup(); resolve('Email sent successfully.') }
          else { cleanup(); reject(new Error(`SMTP send failed: ${data.toString().trim()}`)) }
          break
        case 'quit':
          cleanup()
          break
      }
    }

    if (cfg.secure && cfg.port === 465) {
      socket = tls.connect({ ...connectOpts, rejectUnauthorized: false }, () => {
        (socket as unknown as Record<string, boolean>).encrypted = true
      }) as unknown as import('net').Socket
    } else {
      socket = net.createConnection(connectOpts)
    }

    socket.on('data', handleData)
    socket.on('error', (err: Error) => { cleanup(); reject(err) })
  })
}

async function executeEmail(args: Record<string, unknown>): Promise<string> {
  const normalized = normalizeToolInputArgs(args)
  const action = String(normalized.action || 'send')

  if (action === 'send') {
    const to = normalized.to
    const recipients: string[] = Array.isArray(to) ? to.map(String) : typeof to === 'string' ? to.split(/[,;\s]+/).filter(Boolean) : []
    if (recipients.length === 0) return 'Error: "to" (recipient email addresses) is required.'

    const subject = String(normalized.subject || '').trim()
    if (!subject) return 'Error: "subject" is required.'

    const body = String(normalized.body || '').trim()
    if (!body) return 'Error: "body" (plain text content) is required.'

    const html = typeof normalized.html === 'string' ? normalized.html : undefined

    const cfg = getSmtpConfig()
    if (!cfg.host) return 'Error: SMTP host not configured. Ask the user to configure email in Plugin Settings > Email.'
    if (!cfg.fromAddress) return 'Error: From address not configured in email plugin settings.'

    try {
      const result = await sendSmtpEmail(cfg, recipients, subject, body, html)
      return `${result}\nTo: ${recipients.join(', ')}\nSubject: ${subject}`
    } catch (err: unknown) {
      return `Error sending email: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  if (action === 'status') {
    const cfg = getSmtpConfig()
    if (!cfg.host) return 'Email plugin not configured. No SMTP host set.'
    return JSON.stringify({
      configured: true,
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      from: cfg.fromAddress,
      fromName: cfg.fromName,
    })
  }

  return `Error: Unknown action "${action}". Use "send" or "status".`
}

const EmailPlugin: Plugin = {
  name: 'Email',
  enabledByDefault: false,
  description: 'Send emails via SMTP. Supports plain text and HTML, multiple recipients.',
  hooks: {
    getCapabilityDescription: () =>
      'I can send emails using `email`. Supports plain text and HTML bodies, multiple recipients.',
  } as PluginHooks,
  tools: [
    {
      name: 'email',
      description: 'Send an email or check email configuration status. For sending: provide to, subject, and body. Optionally include html for rich formatting.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['send', 'status'], description: 'Action to perform (default: send)' },
          to: {
            anyOf: [
              { type: 'string', description: 'Recipient email address(es), comma-separated' },
              { type: 'array', items: { type: 'string' }, description: 'Array of recipient email addresses' },
            ],
          },
          subject: { type: 'string', description: 'Email subject line' },
          body: { type: 'string', description: 'Plain text email body' },
          html: { type: 'string', description: 'Optional HTML email body (sent as multipart/alternative alongside plain text)' },
        },
        required: ['action'],
      },
      execute: async (args) => executeEmail(args),
    },
  ],
  ui: {
    settingsFields: [
      {
        key: 'host',
        label: 'SMTP Host',
        type: 'text',
        required: true,
        placeholder: 'smtp.gmail.com',
        help: 'SMTP server hostname.',
      },
      {
        key: 'port',
        label: 'SMTP Port',
        type: 'number',
        defaultValue: 587,
        help: '587 for STARTTLS, 465 for SSL, 25 for unencrypted.',
      },
      {
        key: 'secure',
        label: 'Use SSL/TLS (port 465)',
        type: 'boolean',
        defaultValue: false,
        help: 'Enable for direct TLS connections (port 465). Leave off for STARTTLS (port 587).',
      },
      {
        key: 'username',
        label: 'Username',
        type: 'text',
        placeholder: 'you@gmail.com',
        help: 'SMTP authentication username (usually your email address).',
      },
      {
        key: 'password',
        label: 'Password',
        type: 'secret',
        required: true,
        placeholder: 'App password or SMTP password',
        help: 'SMTP password. For Gmail, use an App Password.',
      },
      {
        key: 'fromAddress',
        label: 'From Address',
        type: 'text',
        required: true,
        placeholder: 'agent@example.com',
        help: 'The sender email address.',
      },
      {
        key: 'fromName',
        label: 'From Name',
        type: 'text',
        defaultValue: 'SwarmClaw Agent',
        placeholder: 'SwarmClaw Agent',
        help: 'Display name shown to recipients.',
      },
    ],
  },
}

getPluginManager().registerBuiltin('email', EmailPlugin)

export function buildEmailTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasPlugin('email')) return []

  return [
    tool(
      async (args) => executeEmail(args),
      {
        name: 'email',
        description: EmailPlugin.tools![0].description,
        schema: z.object({
          action: z.enum(['send', 'status']).optional().describe('Action (default: send)'),
          to: z.union([z.string(), z.array(z.string())]).optional().describe('Recipient email address(es)'),
          subject: z.string().optional().describe('Email subject line'),
          body: z.string().optional().describe('Plain text email body'),
          html: z.string().optional().describe('Optional HTML body'),
        }),
      },
    ),
  ]
}
