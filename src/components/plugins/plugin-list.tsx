'use client'

import { useEffect } from 'react'
import { useAppStore } from '@/stores/use-app-store'

export function PluginList({ inSidebar }: { inSidebar?: boolean }) {
  const plugins = useAppStore((s) => s.plugins)
  const loadPlugins = useAppStore((s) => s.loadPlugins)
  const setPluginSheetOpen = useAppStore((s) => s.setPluginSheetOpen)
  const setEditingPluginFilename = useAppStore((s) => s.setEditingPluginFilename)

  useEffect(() => {
    loadPlugins()
  }, [])

  const pluginList = Object.values(plugins)

  const handleEdit = (filename: string) => {
    setEditingPluginFilename(filename)
    setPluginSheetOpen(true)
  }

  return (
    <div className={`flex-1 overflow-y-auto ${inSidebar ? 'px-3 pb-4' : 'px-4'}`}>
      {pluginList.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-[13px] text-text-3/60">No plugins installed</p>
          <button
            onClick={() => { setEditingPluginFilename(null); setPluginSheetOpen(true) }}
            className="mt-3 px-4 py-2 rounded-[10px] bg-transparent text-accent-bright text-[13px] font-600 cursor-pointer border border-accent-bright/20 hover:bg-accent-soft transition-all"
            style={{ fontFamily: 'inherit' }}
          >
            + Add Plugin
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {pluginList.map((plugin) => (
            <button
              key={plugin.filename}
              onClick={() => handleEdit(plugin.filename)}
              className="w-full text-left p-4 rounded-[14px] border border-white/[0.06] bg-surface hover:bg-surface-2 transition-all cursor-pointer"
            >
              <div className="flex items-center justify-between mb-1">
                <span className="font-display text-[14px] font-600 text-text truncate">{plugin.name}</span>
                <span className={`text-[10px] font-600 px-1.5 py-0.5 rounded-full shrink-0 ml-2 ${plugin.enabled ? 'text-emerald-400 bg-emerald-400/10' : 'text-text-3/50 bg-white/[0.04]'}`}>
                  {plugin.enabled ? 'Enabled' : 'Disabled'}
                </span>
              </div>
              <div className="text-[11px] font-mono text-text-3/50 mb-1">{plugin.filename}</div>
              {plugin.description && (
                <p className="text-[12px] text-text-3/60 line-clamp-2">{plugin.description}</p>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
