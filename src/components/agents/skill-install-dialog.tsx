'use client'

import { useState } from 'react'
import type { SkillInstallOption } from '@/types'
import { api } from '@/lib/api-client'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'

interface Props {
  open: boolean
  onClose: () => void
  skillName: string
  installOptions?: SkillInstallOption[]
  onInstalled: () => void
}

export function SkillInstallDialog({ open, onClose, skillName, installOptions = [], onInstalled }: Props) {
  const [selectedMethod, setSelectedMethod] = useState<string>(installOptions[0]?.kind || 'brew')
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState('')
  const [progress, setProgress] = useState('')

  const handleInstall = async () => {
    setInstalling(true)
    setError('')
    setProgress('Installing...')
    try {
      await api('POST', '/openclaw/skills/install', {
        name: skillName,
        installId: selectedMethod,
        timeoutMs: 120_000,
      })
      setProgress('Installed successfully!')
      onInstalled()
      setTimeout(onClose, 1000)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Installation failed')
      setProgress('')
    } finally {
      setInstalling(false)
    }
  }

  const methods = installOptions.length > 0
    ? installOptions
    : [
        { kind: 'brew' as const, label: 'Homebrew' },
        { kind: 'node' as const, label: 'npm/Node' },
        { kind: 'go' as const, label: 'Go install' },
        { kind: 'uv' as const, label: 'UV (Python)' },
        { kind: 'download' as const, label: 'Direct download' },
      ]

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>Install {skillName}</DialogTitle>
        </DialogHeader>
        <div className="py-3 flex flex-col gap-3">
          <label className="text-[12px] font-600 text-text-3">Install Method</label>
          <div className="flex flex-wrap gap-2">
            {methods.map((m) => (
              <button
                key={m.kind}
                onClick={() => setSelectedMethod(m.kind)}
                disabled={installing}
                className={`px-3 py-1.5 rounded-[8px] text-[12px] font-600 cursor-pointer transition-all border
                  ${selectedMethod === m.kind
                    ? 'bg-accent-soft text-accent-bright border-accent-bright/30'
                    : 'bg-transparent text-text-3 border-white/[0.08] hover:border-white/[0.15]'
                  }`}
                style={{ fontFamily: 'inherit' }}
              >
                {m.label}
              </button>
            ))}
          </div>
          {progress && <p className="text-[12px] text-emerald-400">{progress}</p>}
          {error && <p className="text-[12px] text-red-400">{error}</p>}
        </div>
        <DialogFooter>
          <button
            onClick={onClose}
            disabled={installing}
            className="px-4 py-2 rounded-[10px] border border-white/[0.08] bg-transparent text-text-2 text-[13px] font-600 cursor-pointer hover:bg-surface-2 transition-all"
            style={{ fontFamily: 'inherit' }}
          >
            Cancel
          </button>
          <button
            onClick={handleInstall}
            disabled={installing}
            className="px-4 py-2 rounded-[10px] border-none bg-accent-bright text-white text-[13px] font-600 cursor-pointer disabled:opacity-40 transition-all hover:brightness-110"
            style={{ fontFamily: 'inherit' }}
          >
            {installing ? 'Installing...' : 'Install'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
