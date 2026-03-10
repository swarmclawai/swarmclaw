'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import type { SettingsSectionProps } from './types'

const PRESETS = [
  { label: 'Default', color: '#1e1e30' },
  { label: 'Midnight', color: '#1a1a3a' },
  { label: 'Forest', color: '#1a2e1e' },
  { label: 'Warm', color: '#2e1e1a' },
  { label: 'Slate', color: '#1e2428' },
  { label: 'Rose', color: '#2e1a24' },
]

export function ThemeSection({ appSettings, patchSettings, inputClass }: SettingsSectionProps) {
  const currentHue = appSettings.themeHue || PRESETS[0].color
  const [customHex, setCustomHex] = useState(
    PRESETS.some((p) => p.color === currentHue) ? '' : currentHue,
  )

  const applyHue = (color: string) => {
    patchSettings({ themeHue: color })
    document.documentElement.style.setProperty('--neutral-tint', color)
    toast.success('Theme updated')
  }

  const handleCustomChange = (value: string) => {
    setCustomHex(value)
    if (/^#[0-9a-fA-F]{6}$/.test(value)) {
      applyHue(value)
    }
  }

  return (
    <div className="mb-10">
      <h3 className="font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
        Theme
      </h3>
      <p className="text-[12px] text-text-3 mb-5">
        Shift the UI color palette. Pick a preset or enter a custom hex color.
      </p>

      {/* Preset swatches */}
      <div className="flex flex-wrap gap-3 mb-4">
        {PRESETS.map((preset) => {
          const isActive = currentHue === preset.color && !customHex
          return (
            <button
              key={preset.color}
              onClick={() => { setCustomHex(''); applyHue(preset.color) }}
              className={`group flex flex-col items-center gap-1.5 cursor-pointer bg-transparent border-none p-0`}
              title={preset.label}
            >
              <div
                className={`w-9 h-9 rounded-full transition-all duration-200 ${
                  isActive
                    ? 'ring-2 ring-accent-bright ring-offset-2 ring-offset-bg scale-110'
                    : 'hover:scale-105'
                }`}
                style={{ backgroundColor: preset.color }}
              />
              <span className={`text-[10px] font-500 ${isActive ? 'text-text' : 'text-text-3'}`}>
                {preset.label}
              </span>
            </button>
          )
        })}
      </div>

      {/* Custom color picker + hex input */}
      <div className="flex items-center gap-3">
        <label className="text-[12px] text-text-3 shrink-0">Custom</label>
        <div className="relative shrink-0">
          <input
            type="color"
            value={customHex || currentHue}
            onChange={(e) => handleCustomChange(e.target.value)}
            className="w-9 h-9 rounded-full cursor-pointer border-2 border-white/[0.1] bg-transparent appearance-none [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded-full [&::-webkit-color-swatch]:border-none [&::-moz-color-swatch]:rounded-full [&::-moz-color-swatch]:border-none"
            title="Pick a custom color"
          />
        </div>
        <input
          type="text"
          value={customHex}
          onChange={(e) => handleCustomChange(e.target.value)}
          placeholder="#2a1f3d"
          maxLength={7}
          className={`${inputClass} max-w-[120px] font-mono`}
          style={{ fontFamily: 'inherit' }}
        />
      </div>
    </div>
  )
}
