'use client'

import type { SettingsSectionProps } from './types'

export function WebSearchSection({ appSettings, patchSettings, inputClass }: SettingsSectionProps) {
  const provider = appSettings.webSearchProvider || 'duckduckgo'

  return (
    <div className="mb-10">
      <h3 className="font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
        Web Search
      </h3>
      <p className="text-[12px] text-text-3 mb-5">
        Choose which search engine agents use for the <code className="text-[11px] font-mono text-text-2">web_search</code> tool.
      </p>
      <div className="p-6 rounded-[18px] bg-surface border border-white/[0.06]">
        <div className="mb-5">
          <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Search Provider</label>
          <select
            value={provider}
            onChange={(e) => patchSettings({ webSearchProvider: e.target.value as typeof provider })}
            className={inputClass}
            style={{ fontFamily: 'inherit' }}
          >
            <option value="duckduckgo">DuckDuckGo (default, no key required)</option>
            <option value="google">Google (scraping, no key required)</option>
            <option value="bing">Bing (scraping, no key required)</option>
            <option value="searxng">SearXNG (self-hosted, no key required)</option>
            <option value="tavily">Tavily (requires API key in Secrets)</option>
            <option value="brave">Brave Search (requires API key in Secrets)</option>
          </select>
        </div>

        {provider === 'searxng' && (
          <div>
            <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">SearXNG URL</label>
            <input
              type="text"
              value={appSettings.searxngUrl || ''}
              onChange={(e) => patchSettings({ searxngUrl: e.target.value || undefined })}
              placeholder="http://localhost:8080"
              className={inputClass}
              style={{ fontFamily: 'inherit' }}
            />
          </div>
        )}

        {(provider === 'tavily' || provider === 'brave') && (
          <p className="text-[11px] text-text-3/70">
            Add a secret named &quot;{provider}&quot; or &quot;{provider}_api_key&quot; in the Secrets section below.
          </p>
        )}
      </div>
    </div>
  )
}
