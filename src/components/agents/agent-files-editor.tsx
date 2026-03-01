'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api-client'
import { PersonalityBuilder } from './personality-builder'

const FILES = ['SOUL.md', 'IDENTITY.md', 'USER.md', 'TOOLS.md', 'HEARTBEAT.md', 'MEMORY.md', 'AGENTS.md'] as const
const GUIDED_FILES = new Set(['SOUL.md', 'IDENTITY.md', 'USER.md'])

interface FileState {
  content: string
  original: string
  loading: boolean
  saving: boolean
  error?: string
}

interface Props {
  agentId: string
}

export function AgentFilesEditor({ agentId }: Props) {
  const [activeTab, setActiveTab] = useState<string>(FILES[0])
  const [files, setFiles] = useState<Record<string, FileState>>({})
  const [guidedMode, setGuidedMode] = useState(false)

  const loadFiles = useCallback(async () => {
    const initial: Record<string, FileState> = {}
    for (const f of FILES) {
      initial[f] = { content: '', original: '', loading: true, saving: false }
    }
    setFiles(initial)

    try {
      const result = await api<Record<string, { content: string; error?: string }>>('GET', `/openclaw/agent-files?agentId=${agentId}`)
      setFiles((prev) => {
        const next = { ...prev }
        for (const [name, data] of Object.entries(result)) {
          next[name] = {
            content: data.content,
            original: data.content,
            loading: false,
            saving: false,
            error: data.error,
          }
        }
        return next
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setFiles((prev) => {
        const next = { ...prev }
        for (const f of FILES) {
          next[f] = { ...next[f], loading: false, error: message }
        }
        return next
      })
    }
  }, [agentId])

  useEffect(() => { loadFiles() }, [loadFiles])

  const handleContentChange = (filename: string, content: string) => {
    setFiles((prev) => ({
      ...prev,
      [filename]: { ...prev[filename], content },
    }))
  }

  const handleSave = async (filename: string) => {
    const file = files[filename]
    if (!file || file.content === file.original) return

    setFiles((prev) => ({
      ...prev,
      [filename]: { ...prev[filename], saving: true, error: undefined },
    }))

    try {
      await api('PUT', '/openclaw/agent-files', { agentId, filename, content: file.content })
      setFiles((prev) => ({
        ...prev,
        [filename]: { ...prev[filename], saving: false, original: prev[filename].content },
      }))
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setFiles((prev) => ({
        ...prev,
        [filename]: { ...prev[filename], saving: false, error: message },
      }))
    }
  }

  const handleGuidedSave = (content: string) => {
    handleContentChange(activeTab, content)
  }

  const current = files[activeTab]
  const isDirty = current && current.content !== current.original
  const showGuided = guidedMode && GUIDED_FILES.has(activeTab)

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex gap-0.5 px-2 pt-2 pb-1 overflow-x-auto shrink-0">
        {FILES.map((f) => {
          const fileState = files[f]
          const dirty = fileState && fileState.content !== fileState.original
          return (
            <button
              key={f}
              onClick={() => setActiveTab(f)}
              className={`px-2.5 py-1.5 rounded-[8px] text-[11px] font-600 cursor-pointer transition-all whitespace-nowrap
                ${activeTab === f
                  ? 'bg-accent-soft text-accent-bright'
                  : 'bg-transparent text-text-3 hover:text-text-2'}`}
              style={{ fontFamily: 'inherit' }}
            >
              {f.replace('.md', '')}
              {dirty && <span className="ml-1 text-amber-400">*</span>}
            </button>
          )
        })}
      </div>

      {/* Guided toggle for personality files */}
      {GUIDED_FILES.has(activeTab) && (
        <div className="px-3 py-1 shrink-0">
          <button
            onClick={() => setGuidedMode(!guidedMode)}
            className={`text-[10px] font-600 px-2 py-0.5 rounded-[6px] cursor-pointer transition-all border-none
              ${guidedMode ? 'bg-accent-soft text-accent-bright' : 'bg-white/[0.04] text-text-3 hover:text-text-2'}`}
            style={{ fontFamily: 'inherit' }}
          >
            {guidedMode ? 'Raw Editor' : 'Guided Editor'}
          </button>
        </div>
      )}

      {/* Editor area */}
      <div className="flex-1 min-h-0 px-2 pb-2 overflow-y-auto">
        {current?.loading ? (
          <div className="flex items-center justify-center h-full text-[13px] text-text-3/50">Loading...</div>
        ) : current?.error ? (
          <div className="flex items-center justify-center h-full text-[13px] text-red-400">{current.error}</div>
        ) : showGuided ? (
          <div className="p-2">
            <PersonalityBuilder
              agentId={agentId}
              fileType={activeTab as 'IDENTITY.md' | 'USER.md' | 'SOUL.md'}
              content={current?.content ?? ''}
              onSave={handleGuidedSave}
            />
          </div>
        ) : (
          <textarea
            value={current?.content ?? ''}
            onChange={(e) => handleContentChange(activeTab, e.target.value)}
            className="w-full h-full resize-none rounded-[10px] border border-white/[0.06] bg-black/20 px-3 py-2.5
              text-[13px] text-text font-mono leading-relaxed outline-none
              placeholder:text-text-3/40 focus:border-white/[0.12] transition-colors"
            placeholder={`${activeTab} content...`}
            style={{ fontFamily: 'ui-monospace, monospace' }}
          />
        )}
      </div>

      {/* Save bar */}
      <div className="shrink-0 px-3 pb-2 flex items-center gap-2">
        <button
          onClick={() => handleSave(activeTab)}
          disabled={!isDirty || current?.saving}
          className="px-4 py-1.5 rounded-[8px] border-none bg-accent-bright text-white text-[12px] font-600
            cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed transition-all hover:brightness-110"
          style={{ fontFamily: 'inherit' }}
        >
          {current?.saving ? 'Saving...' : 'Save'}
        </button>
        {isDirty && (
          <span className="text-[11px] text-amber-400/70">Unsaved changes</span>
        )}
      </div>
    </div>
  )
}
