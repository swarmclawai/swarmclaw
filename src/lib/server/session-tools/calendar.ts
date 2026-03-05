import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import type { Plugin, PluginHooks } from '@/types'
import { getPluginManager } from '../plugins'
import { normalizeToolInputArgs } from './normalize-tool-args'
import { loadSettings } from '../storage'
import type { ToolBuildContext } from './context'

type CalendarProvider = 'google' | 'outlook'

interface CalendarConfig {
  provider: CalendarProvider
  accessToken: string
  calendarId: string
  refreshToken: string
  clientId: string
  clientSecret: string
}

function getConfig(): CalendarConfig {
  const settings = loadSettings()
  const ps = (settings.pluginSettings as Record<string, Record<string, unknown>> | undefined)?.calendar ?? {}
  return {
    provider: (ps.provider as CalendarProvider) || 'google',
    accessToken: (ps.accessToken as string) || '',
    calendarId: (ps.calendarId as string) || 'primary',
    refreshToken: (ps.refreshToken as string) || '',
    clientId: (ps.clientId as string) || '',
    clientSecret: (ps.clientSecret as string) || '',
  }
}

/** Try to refresh the Google OAuth access token using the refresh token. */
async function refreshGoogleToken(cfg: CalendarConfig): Promise<string | null> {
  if (!cfg.refreshToken || !cfg.clientId || !cfg.clientSecret) return null
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: cfg.refreshToken,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const data = await res.json()
    const newToken = data?.access_token as string | undefined
    if (newToken) {
      // Persist the refreshed token
      const settings = loadSettings()
      const pluginSettings = (settings.pluginSettings as Record<string, Record<string, unknown>> | undefined) ?? {}
      const calSettings = pluginSettings.calendar ?? {}
      calSettings.accessToken = newToken
      pluginSettings.calendar = calSettings
      settings.pluginSettings = pluginSettings
      const { saveSettings } = await import('../storage')
      saveSettings(settings)
    }
    return newToken || null
  } catch {
    return null
  }
}

async function googleRequest(method: string, urlPath: string, cfg: CalendarConfig, body?: unknown): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  let token = cfg.accessToken
  const baseUrl = 'https://www.googleapis.com/calendar/v3'

  const doFetch = async (t: string) => {
    const init: RequestInit = {
      method,
      headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
    }
    if (body && method !== 'GET' && method !== 'DELETE') init.body = JSON.stringify(body)
    return fetch(`${baseUrl}${urlPath}`, init)
  }

  let res = await doFetch(token)
  if (res.status === 401) {
    const refreshed = await refreshGoogleToken(cfg)
    if (refreshed) {
      token = refreshed
      res = await doFetch(token)
    }
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    return { ok: false, error: `Google Calendar ${res.status}: ${errText.slice(0, 300)}` }
  }
  if (method === 'DELETE') return { ok: true }
  const data = await res.json()
  return { ok: true, data }
}

async function outlookRequest(method: string, urlPath: string, cfg: CalendarConfig, body?: unknown): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const baseUrl = 'https://graph.microsoft.com/v1.0/me'
  const init: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15_000),
  }
  if (body && method !== 'GET' && method !== 'DELETE') init.body = JSON.stringify(body)
  const res = await fetch(`${baseUrl}${urlPath}`, init)
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    return { ok: false, error: `Outlook ${res.status}: ${errText.slice(0, 300)}` }
  }
  if (method === 'DELETE') return { ok: true }
  const data = await res.json()
  return { ok: true, data }
}

function formatEvent(e: Record<string, unknown>): Record<string, unknown> {
  return {
    id: e.id,
    summary: e.summary ?? e.subject,
    start: (e.start as Record<string, unknown>)?.dateTime ?? (e.start as Record<string, unknown>)?.date ?? e.start,
    end: (e.end as Record<string, unknown>)?.dateTime ?? (e.end as Record<string, unknown>)?.date ?? e.end,
    location: e.location ?? (e.location as unknown as Record<string, unknown>)?.displayName,
    description: typeof e.description === 'string' ? e.description.slice(0, 200) : (e.body as Record<string, unknown>)?.content?.toString().slice(0, 200),
    status: e.status ?? e.showAs,
    htmlLink: e.htmlLink ?? e.webLink,
  }
}

async function executeCalendar(args: Record<string, unknown>): Promise<string> {
  const normalized = normalizeToolInputArgs(args)
  const action = String(normalized.action || 'list')
  const cfg = getConfig()

  if (!cfg.accessToken) {
    return 'Error: Calendar not configured. Ask the user to add their access token in Plugin Settings > Calendar.'
  }

  try {
    switch (action) {
      case 'list': {
        const timeMin = String(normalized.timeMin || new Date().toISOString())
        const timeMax = normalized.timeMax as string | undefined
        const maxResults = Math.min(Number(normalized.maxResults) || 20, 50)

        if (cfg.provider === 'outlook') {
          const params = new URLSearchParams({
            $top: String(maxResults),
            $orderby: 'start/dateTime',
            $filter: `start/dateTime ge '${timeMin}'${timeMax ? ` and end/dateTime le '${timeMax}'` : ''}`,
          })
          const r = await outlookRequest('GET', `/calendar/events?${params}`, cfg)
          if (!r.ok) return `Error: ${r.error}`
          const events = ((r.data as Record<string, unknown>)?.value as Record<string, unknown>[]) ?? []
          return JSON.stringify(events.map(formatEvent))
        }

        const params = new URLSearchParams({
          timeMin,
          maxResults: String(maxResults),
          singleEvents: 'true',
          orderBy: 'startTime',
        })
        if (timeMax) params.set('timeMax', timeMax)
        const r = await googleRequest('GET', `/calendars/${encodeURIComponent(cfg.calendarId)}/events?${params}`, cfg)
        if (!r.ok) return `Error: ${r.error}`
        const events = ((r.data as Record<string, unknown>)?.items as Record<string, unknown>[]) ?? []
        return JSON.stringify(events.map(formatEvent))
      }

      case 'create': {
        const summary = String(normalized.summary || normalized.title || '').trim()
        if (!summary) return 'Error: "summary" (event title) is required.'
        const start = String(normalized.start || '').trim()
        const end = String(normalized.end || '').trim()
        if (!start) return 'Error: "start" (ISO datetime) is required.'

        const description = (normalized.description as string) || ''
        const location = (normalized.location as string) || ''

        if (cfg.provider === 'outlook') {
          const body = {
            subject: summary,
            body: { contentType: 'text', content: description },
            start: { dateTime: start, timeZone: 'UTC' },
            end: { dateTime: end || new Date(new Date(start).getTime() + 3600_000).toISOString(), timeZone: 'UTC' },
            location: { displayName: location },
          }
          const r = await outlookRequest('POST', '/calendar/events', cfg, body)
          if (!r.ok) return `Error: ${r.error}`
          return `Event created: ${JSON.stringify(formatEvent(r.data as Record<string, unknown>))}`
        }

        const body = {
          summary,
          description,
          location,
          start: { dateTime: start, timeZone: 'UTC' },
          end: { dateTime: end || new Date(new Date(start).getTime() + 3600_000).toISOString(), timeZone: 'UTC' },
        }
        const r = await googleRequest('POST', `/calendars/${encodeURIComponent(cfg.calendarId)}/events`, cfg, body)
        if (!r.ok) return `Error: ${r.error}`
        return `Event created: ${JSON.stringify(formatEvent(r.data as Record<string, unknown>))}`
      }

      case 'update': {
        const eventId = String(normalized.eventId || normalized.id || '').trim()
        if (!eventId) return 'Error: "eventId" is required.'
        const updates: Record<string, unknown> = {}
        if (normalized.summary) updates.summary = String(normalized.summary)
        if (normalized.description) updates.description = String(normalized.description)
        if (normalized.location) updates.location = String(normalized.location)
        if (normalized.start) updates.start = { dateTime: String(normalized.start), timeZone: 'UTC' }
        if (normalized.end) updates.end = { dateTime: String(normalized.end), timeZone: 'UTC' }

        if (cfg.provider === 'outlook') {
          const outlookUpdates: Record<string, unknown> = {}
          if (normalized.summary) outlookUpdates.subject = String(normalized.summary)
          if (normalized.description) outlookUpdates.body = { contentType: 'text', content: String(normalized.description) }
          if (normalized.location) outlookUpdates.location = { displayName: String(normalized.location) }
          if (normalized.start) outlookUpdates.start = { dateTime: String(normalized.start), timeZone: 'UTC' }
          if (normalized.end) outlookUpdates.end = { dateTime: String(normalized.end), timeZone: 'UTC' }
          const r = await outlookRequest('PATCH', `/calendar/events/${eventId}`, cfg, outlookUpdates)
          if (!r.ok) return `Error: ${r.error}`
          return `Event updated: ${JSON.stringify(formatEvent(r.data as Record<string, unknown>))}`
        }

        const r = await googleRequest('PATCH', `/calendars/${encodeURIComponent(cfg.calendarId)}/events/${eventId}`, cfg, updates)
        if (!r.ok) return `Error: ${r.error}`
        return `Event updated: ${JSON.stringify(formatEvent(r.data as Record<string, unknown>))}`
      }

      case 'delete': {
        const eventId = String(normalized.eventId || normalized.id || '').trim()
        if (!eventId) return 'Error: "eventId" is required.'

        if (cfg.provider === 'outlook') {
          const r = await outlookRequest('DELETE', `/calendar/events/${eventId}`, cfg)
          if (!r.ok) return `Error: ${r.error}`
          return `Event ${eventId} deleted.`
        }

        const r = await googleRequest('DELETE', `/calendars/${encodeURIComponent(cfg.calendarId)}/events/${eventId}`, cfg)
        if (!r.ok) return `Error: ${r.error}`
        return `Event ${eventId} deleted.`
      }

      case 'status': {
        return JSON.stringify({
          configured: true,
          provider: cfg.provider,
          calendarId: cfg.calendarId,
          hasRefreshToken: !!cfg.refreshToken,
        })
      }

      default:
        return `Error: Unknown action "${action}". Use: list, create, update, delete, status.`
    }
  } catch (err: unknown) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

const CalendarPlugin: Plugin = {
  name: 'Calendar',
  enabledByDefault: false,
  description: 'Manage Google Calendar or Outlook calendar events — list, create, update, delete.',
  hooks: {
    getCapabilityDescription: () =>
      'I can manage calendar events using `calendar`: list upcoming events, create new ones, update or delete existing events. Supports Google Calendar and Outlook.',
  } as PluginHooks,
  tools: [
    {
      name: 'calendar',
      description: 'Manage calendar events. Actions: list (upcoming events), create (new event), update (modify event), delete (remove event), status (check config).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'create', 'update', 'delete', 'status'], description: 'Action to perform' },
          summary: { type: 'string', description: 'Event title (for create/update)' },
          description: { type: 'string', description: 'Event description (for create/update)' },
          location: { type: 'string', description: 'Event location (for create/update)' },
          start: { type: 'string', description: 'Start datetime in ISO 8601 format (for create/update)' },
          end: { type: 'string', description: 'End datetime in ISO 8601 format (for create/update). Defaults to 1 hour after start.' },
          eventId: { type: 'string', description: 'Event ID (for update/delete)' },
          timeMin: { type: 'string', description: 'List events starting from this ISO datetime (default: now)' },
          timeMax: { type: 'string', description: 'List events up to this ISO datetime' },
          maxResults: { type: 'number', description: 'Max events to return (default: 20, max: 50)' },
        },
        required: ['action'],
      },
      execute: async (args) => executeCalendar(args),
    },
  ],
  ui: {
    settingsFields: [
      {
        key: 'provider',
        label: 'Calendar Provider',
        type: 'select',
        options: [
          { value: 'google', label: 'Google Calendar' },
          { value: 'outlook', label: 'Microsoft Outlook' },
        ],
        defaultValue: 'google',
      },
      {
        key: 'accessToken',
        label: 'Access Token',
        type: 'secret',
        required: true,
        placeholder: 'ya29.a0...',
        help: 'OAuth2 access token for the calendar API. For Google: generate via OAuth2 playground or a service account.',
      },
      {
        key: 'refreshToken',
        label: 'Refresh Token (Google)',
        type: 'secret',
        placeholder: '1//0e...',
        help: 'Google OAuth2 refresh token. When set, the plugin auto-refreshes expired access tokens.',
      },
      {
        key: 'clientId',
        label: 'Client ID (Google)',
        type: 'text',
        placeholder: '123456789.apps.googleusercontent.com',
        help: 'Google OAuth2 client ID. Required for token refresh.',
      },
      {
        key: 'clientSecret',
        label: 'Client Secret (Google)',
        type: 'secret',
        placeholder: 'GOCSPX-...',
        help: 'Google OAuth2 client secret. Required for token refresh.',
      },
      {
        key: 'calendarId',
        label: 'Calendar ID',
        type: 'text',
        defaultValue: 'primary',
        placeholder: 'primary',
        help: 'Google Calendar ID (default: "primary"). For Outlook, this is ignored.',
      },
    ],
  },
}

getPluginManager().registerBuiltin('calendar', CalendarPlugin)

export function buildCalendarTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasPlugin('calendar')) return []

  return [
    tool(
      async (args) => executeCalendar(args),
      {
        name: 'calendar',
        description: CalendarPlugin.tools![0].description,
        schema: z.object({
          action: z.enum(['list', 'create', 'update', 'delete', 'status']).describe('Action to perform'),
          summary: z.string().optional().describe('Event title'),
          description: z.string().optional().describe('Event description'),
          location: z.string().optional().describe('Event location'),
          start: z.string().optional().describe('Start datetime (ISO 8601)'),
          end: z.string().optional().describe('End datetime (ISO 8601)'),
          eventId: z.string().optional().describe('Event ID (for update/delete)'),
          timeMin: z.string().optional().describe('List events from this datetime'),
          timeMax: z.string().optional().describe('List events until this datetime'),
          maxResults: z.number().optional().describe('Max results (default 20, max 50)'),
        }),
      },
    ),
  ]
}
