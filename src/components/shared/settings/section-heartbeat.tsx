'use client'

import { useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { api } from '@/lib/api-client'
import type { SettingsSectionProps } from './types'

export function HeartbeatSection({ appSettings, patchSettings, inputClass }: SettingsSectionProps) {
  const loadSessions = useAppStore((s) => s.loadSessions)
  const [disablingHeartbeats, setDisablingHeartbeats] = useState(false)
  const [heartbeatBulkNotice, setHeartbeatBulkNotice] = useState('')

  const handleDisableAllHeartbeats = async () => {
    if (disablingHeartbeats) return
    setDisablingHeartbeats(true)
    setHeartbeatBulkNotice('')
    try {
      const result = await api<{
        ok: boolean
        updatedSessions: number
        cancelledQueued: number
        abortedRunning: number
      }>('POST', '/sessions/heartbeat', { action: 'disable_all' })
      await loadSessions()
      setHeartbeatBulkNotice(
        `Stopped heartbeat on ${result.updatedSessions} session(s); cancelled ${result.cancelledQueued} queued run(s), aborted ${result.abortedRunning} running run(s).`,
      )
    } catch (err: any) {
      setHeartbeatBulkNotice(err?.message || 'Failed to disable heartbeat for all agents.')
    } finally {
      setDisablingHeartbeats(false)
    }
  }

  return (
    <div className="mb-10">
      <h3 className="font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
        Heartbeat Defaults
      </h3>
      <p className="text-[12px] text-text-3 mb-5">
        Global defaults inherited by agents. Enable heartbeat and set interval/model per-agent in the agent editor.
      </p>
      <div className="p-6 rounded-[18px] bg-surface border border-white/[0.06]">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-5">
          <div>
            <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Default Prompt</label>
            <input
              type="text"
              value={appSettings.heartbeatPrompt || ''}
              onChange={(e) => patchSettings({ heartbeatPrompt: e.target.value || null })}
              placeholder="Leave blank for built-in default"
              className={inputClass}
              style={{ fontFamily: 'inherit' }}
            />
          </div>
          <div>
            <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Ack Threshold (chars)</label>
            <input
              type="number"
              min={0}
              value={appSettings.heartbeatAckMaxChars ?? 300}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10)
                patchSettings({ heartbeatAckMaxChars: Number.isFinite(n) ? Math.max(0, n) : 300 })
              }}
              className={inputClass}
              style={{ fontFamily: 'inherit' }}
            />
            <p className="text-[11px] text-text-3/60 mt-2">Responses under this length are suppressed as HEARTBEAT_OK.</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-5">
          <div>
            <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Show OK Messages</label>
            <button
              onClick={() => patchSettings({ heartbeatShowOk: !(appSettings.heartbeatShowOk ?? false) })}
              className={`px-3 py-2 rounded-[10px] border text-[12px] font-600 transition-colors cursor-pointer ${
                appSettings.heartbeatShowOk
                  ? 'border-emerald-400/25 bg-emerald-500/10 text-emerald-300'
                  : 'border-white/[0.08] bg-white/[0.03] text-text-3'
              }`}
              style={{ fontFamily: 'inherit' }}
            >
              {appSettings.heartbeatShowOk ? 'On' : 'Off'}
            </button>
          </div>
          <div>
            <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Show Alert Messages</label>
            <button
              onClick={() => patchSettings({ heartbeatShowAlerts: !(appSettings.heartbeatShowAlerts ?? true) })}
              className={`px-3 py-2 rounded-[10px] border text-[12px] font-600 transition-colors cursor-pointer ${
                (appSettings.heartbeatShowAlerts ?? true)
                  ? 'border-emerald-400/25 bg-emerald-500/10 text-emerald-300'
                  : 'border-white/[0.08] bg-white/[0.03] text-text-3'
              }`}
              style={{ fontFamily: 'inherit' }}
            >
              {(appSettings.heartbeatShowAlerts ?? true) ? 'On' : 'Off'}
            </button>
          </div>
          <div>
            <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Delivery Target</label>
            <input
              type="text"
              value={appSettings.heartbeatTarget || ''}
              onChange={(e) => patchSettings({ heartbeatTarget: e.target.value || null })}
              placeholder="none, last, or channel ID"
              className={inputClass}
              style={{ fontFamily: 'inherit' }}
            />
          </div>
        </div>

        <div>
          <div className="flex items-center gap-2.5">
            <button
              onClick={handleDisableAllHeartbeats}
              disabled={disablingHeartbeats}
              className="px-3.5 py-2 rounded-[10px] border border-rose-400/25 bg-rose-500/10 text-rose-300 hover:bg-rose-500/16 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed text-[12px] font-600"
              style={{ fontFamily: 'inherit' }}
            >
              {disablingHeartbeats ? 'Stopping\u2026' : 'Stop All Heartbeats'}
            </button>
            <span className="text-[11px] text-text-3/70">
              Disables heartbeat on every agent and cancels queued runs.
            </span>
          </div>
          {heartbeatBulkNotice && (
            <p className="text-[11px] text-text-3/70 mt-2">{heartbeatBulkNotice}</p>
          )}
        </div>
      </div>
    </div>
  )
}
