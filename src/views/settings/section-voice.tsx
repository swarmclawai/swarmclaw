'use client'

import type { SettingsSectionProps } from './types'

export function VoiceSection({ appSettings, patchSettings, inputClass }: SettingsSectionProps) {
  const enabled = appSettings.elevenLabsEnabled ?? false
  const hasApiKey = appSettings.elevenLabsApiKeyConfigured === true
  const defaultVoiceId = typeof appSettings.elevenLabsVoiceId === 'string' ? appSettings.elevenLabsVoiceId.trim() : ''
  const showVoiceConfig = enabled || hasApiKey || Boolean(defaultVoiceId)

  return (
    <div className="mb-10">
      <h3 className="font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
        Voice
      </h3>
      <p className="text-[12px] text-text-3 mb-5">
        Configure voice playback (TTS), the default ElevenLabs voice, and speech-to-text input.
      </p>
      <div className="p-6 rounded-[18px] bg-surface border border-white/[0.06]">
        {/* ElevenLabs toggle */}
        <div className="flex items-center justify-between mb-5">
          <div>
            <label className="font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em]">ElevenLabs TTS</label>
            <p className="text-[11px] text-text-3/60 mt-0.5">Enable text-to-speech for agent responses</p>
          </div>
          <button
            type="button"
            onClick={() => patchSettings({ elevenLabsEnabled: !enabled })}
            className={`relative w-10 h-[22px] rounded-full transition-colors cursor-pointer border-none ${enabled ? 'bg-accent-bright' : 'bg-surface-3'}`}
          >
            <span className={`absolute top-[3px] left-[3px] w-4 h-4 rounded-full bg-white transition-transform ${enabled ? 'translate-x-[18px]' : ''}`} />
          </button>
        </div>

        {showVoiceConfig && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-5">
            <div>
              <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">API Key</label>
              <input
                type="password"
                value={appSettings.elevenLabsApiKey || ''}
                onChange={(e) => patchSettings({ elevenLabsApiKey: e.target.value || null })}
                placeholder={hasApiKey ? 'Stored securely. Enter a new key to replace it.' : 'sk_...'}
                className={inputClass}
                style={{ fontFamily: 'inherit' }}
              />
              {hasApiKey && (
                <p className="text-[11px] text-emerald-400/90 mt-1.5">Stored securely. Clear the field and save to remove it.</p>
              )}
            </div>
            <div>
              <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Default Voice ID</label>
              <input
                type="text"
                value={appSettings.elevenLabsVoiceId || ''}
                onChange={(e) => patchSettings({ elevenLabsVoiceId: e.target.value || null })}
                placeholder="JBFqnCBsd6RMkjVDRZzb"
                className={inputClass}
                style={{ fontFamily: 'inherit' }}
              />
              <p className="text-[11px] text-text-3/60 mt-1.5">Fallback voice when an agent has no override set. Agents can override this in their own create/edit sheet.</p>
            </div>
          </div>
        )}

        {showVoiceConfig && !enabled && (
          <p className="mb-5 rounded-[12px] border border-white/[0.06] bg-white/[0.03] px-3 py-2.5 text-[11px] text-text-3/70">
            ElevenLabs credentials and default voice can be prepared here even while playback is turned off.
          </p>
        )}

        <div>
          <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Speech Recognition Language</label>
          <input
            type="text"
            value={appSettings.speechRecognitionLang || ''}
            onChange={(e) => patchSettings({ speechRecognitionLang: e.target.value || null })}
            placeholder="en-US (blank = browser default)"
            className={inputClass}
            style={{ fontFamily: 'inherit' }}
          />
        </div>
      </div>
    </div>
  )
}
