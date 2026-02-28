'use client'

import type { SettingsSectionProps } from './types'

export function VoiceSection({ appSettings, patchSettings, inputClass }: SettingsSectionProps) {
  return (
    <div className="mb-10">
      <h3 className="font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
        Voice
      </h3>
      <p className="text-[12px] text-text-3 mb-5">
        Configure voice playback (TTS) and speech-to-text input.
      </p>
      <div className="p-6 rounded-[18px] bg-surface border border-white/[0.06]">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-5">
          <div>
            <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">ElevenLabs API Key</label>
            <input
              type="password"
              value={appSettings.elevenLabsApiKey || ''}
              onChange={(e) => patchSettings({ elevenLabsApiKey: e.target.value || null })}
              placeholder="sk_..."
              className={inputClass}
              style={{ fontFamily: 'inherit' }}
            />
          </div>
          <div>
            <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">ElevenLabs Voice ID</label>
            <input
              type="text"
              value={appSettings.elevenLabsVoiceId || ''}
              onChange={(e) => patchSettings({ elevenLabsVoiceId: e.target.value || null })}
              placeholder="JBFqnCBsd6RMkjVDRZzb"
              className={inputClass}
              style={{ fontFamily: 'inherit' }}
            />
          </div>
        </div>
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
