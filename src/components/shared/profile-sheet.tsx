'use client'

import { useState, useEffect } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { api } from '@/lib/app/api-client'
import { toast } from 'sonner'

interface Props {
  open: boolean
  onClose: () => void
}

export function ProfileSheet({ open, onClose }: Props) {
  const appSettings = useAppStore((s) => s.appSettings)
  const loadSettings = useAppStore((s) => s.loadSettings)
  const setUser = useAppStore((s) => s.setUser)
  const currentUser = useAppStore((s) => s.currentUser)

  const [name, setName] = useState('')
  const [avatarSeed, setAvatarSeed] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setName(appSettings.userName || currentUser || '')
      setAvatarSeed(appSettings.userAvatarSeed || '')
    }
  }, [open, appSettings.userName, appSettings.userAvatarSeed, currentUser])

  const handleSave = async () => {
    const trimmed = name.trim()
    if (!trimmed || saving) return
    setSaving(true)
    try {
      await api('PUT', '/settings', {
        userName: trimmed.toLowerCase(),
        userAvatarSeed: avatarSeed.trim() || undefined,
      })
      setUser(trimmed.toLowerCase())
      await loadSettings()
      toast.success('Profile updated')
      onClose()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to update profile')
    } finally {
      setSaving(false)
    }
  }

  const handleSignOut = () => {
    setUser(null)
    onClose()
  }

  return (
    <BottomSheet open={open} onClose={onClose}>
      <div className="p-6 max-w-[400px] mx-auto">
        <h2 className="font-display text-[18px] font-700 text-text mb-6 text-center">Profile</h2>

        {/* Avatar preview */}
        <div className="flex justify-center mb-6">
          <AgentAvatar seed={avatarSeed || null} name={name || '?'} size={72} />
        </div>

        {/* Avatar seed */}
        <div className="mb-4">
          <label className="block text-[12px] font-600 text-text-2 mb-1.5">Avatar</label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={avatarSeed}
              onChange={(e) => setAvatarSeed(e.target.value)}
              placeholder="Avatar seed (any text)"
              className="flex-1 px-3 py-2 rounded-[8px] bg-white/[0.06] border border-white/[0.08] text-[13px] text-text placeholder:text-text-3 focus:outline-none focus:border-accent-bright/40"
            />
            <button
              type="button"
              onClick={() => setAvatarSeed(Math.random().toString(36).slice(2, 10))}
              className="px-3 py-2 rounded-[8px] border border-white/[0.08] bg-transparent text-text-3 text-[12px] font-600 cursor-pointer transition-all hover:bg-white/[0.04] shrink-0"
            >
              Randomize
            </button>
          </div>
        </div>

        {/* Name */}
        <div className="mb-6">
          <label className="block text-[12px] font-600 text-text-2 mb-1.5">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            className="w-full px-3 py-2 rounded-[8px] bg-white/[0.06] border border-white/[0.08] text-[13px] text-text placeholder:text-text-3 focus:outline-none focus:border-accent-bright/40"
          />
        </div>

        {/* Save */}
        <button
          onClick={handleSave}
          disabled={!name.trim() || saving}
          className="w-full py-2.5 rounded-[8px] text-[13px] font-600 bg-accent-bright text-white hover:bg-accent-bright/90 transition-all disabled:opacity-50 cursor-pointer mb-4"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>

        {/* Sign out */}
        <button
          onClick={handleSignOut}
          className="w-full text-center text-[12px] text-text-3 hover:text-text-2 transition-all cursor-pointer bg-transparent border-none"
        >
          Sign in as different user
        </button>
      </div>
    </BottomSheet>
  )
}
