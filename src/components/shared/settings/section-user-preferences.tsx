'use client'

import type { SettingsSectionProps } from './types'

export function UserPreferencesSection({ appSettings, patchSettings, inputClass }: SettingsSectionProps) {
  return (
    <div className="mb-10">
      <h3 className="font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
        User Preferences
      </h3>
      <p className="text-[12px] text-text-3 mb-5">
        Global instructions injected into ALL agent system prompts. Define your style, rules, and preferences.
      </p>
      <textarea
        value={appSettings.userPrompt || ''}
        onChange={(e) => patchSettings({ userPrompt: e.target.value })}
        placeholder="e.g. Always respond concisely. Use TypeScript over JavaScript. Prefer functional patterns. My timezone is PST."
        rows={4}
        className={`${inputClass} resize-y min-h-[100px]`}
        style={{ fontFamily: 'inherit' }}
      />
    </div>
  )
}
