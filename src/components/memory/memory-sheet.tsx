'use client'

import { useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { createMemory } from '@/lib/memory'
import { getMemoryTierForCategory } from '@/lib/memory-presentation'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { SheetFooter } from '@/components/shared/sheet-footer'
import { inputClass } from '@/components/shared/form-styles'

const CATEGORIES = ['note', 'fact', 'preference', 'finding', 'learning', 'general']

export function MemorySheet() {
  const open = useAppStore((s) => s.memorySheetOpen)
  const setOpen = useAppStore((s) => s.setMemorySheetOpen)
  const triggerRefresh = useAppStore((s) => s.triggerMemoryRefresh)
  const agents = useAppStore((s) => s.agents)
  const memoryAgentFilter = useAppStore((s) => s.memoryAgentFilter)

  // Track open transitions to reset form
  const [prevOpen, setPrevOpen] = useState(false)
  const defaultAgentId = memoryAgentFilter && memoryAgentFilter !== '_global' ? memoryAgentFilter : null

  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [category, setCategory] = useState('note')
  const [tier, setTier] = useState<'working' | 'durable' | 'archive'>(getMemoryTierForCategory('note'))
  const [agentId, setAgentId] = useState<string | null>(defaultAgentId)
  const [sharedWith, setSharedWith] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  // Reset form when sheet opens (getDerivedStateFromProps pattern)
  if (open && !prevOpen) {
    setPrevOpen(true)
    setAgentId(defaultAgentId)
    setSharedWith([])
    setTitle('')
    setContent('')
    setCategory('note')
    setTier(getMemoryTierForCategory('note'))
    setSaving(false)
  } else if (!open && prevOpen) {
    setPrevOpen(false)
  }

  const onClose = () => {
    setOpen(false)
  }

  const handleSave = async () => {
    if (!title.trim()) return
    setSaving(true)
    try {
      await createMemory({
        title: title.trim(),
        category,
        content,
        agentId,
        sessionId: null,
        sharedWith: sharedWith.length ? sharedWith : undefined,
        metadata: {
          tier,
          scope: agentId ? 'agent' : 'global',
          visibility: agentId ? (sharedWith.length ? 'shared' : 'private') : 'global',
        },
      })
      triggerRefresh()
      onClose()
    } catch {
      /* ignore */
    }
    setSaving(false)
  }

  const agentList = Object.values(agents).sort((a, b) => a.name.localeCompare(b.name))
  const selectedAgent = agentId ? agents[agentId] : null

  return (
    <BottomSheet open={open} onClose={onClose}>
      <div className="mb-8">
        <h2 className="font-display text-[28px] font-700 tracking-[-0.03em] mb-2">New Memory</h2>
        <p className="text-[14px] text-text-3">Store a piece of knowledge for an agent or globally</p>
      </div>

      {/* Agent selector */}
      <div className="mb-6">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Visibility</label>
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => setAgentId(null)}
            className={`flex items-center gap-2 px-3 py-2 rounded-[10px] text-[13px] font-600 cursor-pointer transition-all border
              ${!agentId
                ? 'bg-accent-soft border-accent-bright/20 text-accent-bright'
                : 'bg-white/[0.02] border-white/[0.06] text-text-3 hover:text-text-2 hover:bg-white/[0.04]'}`}
            style={{ fontFamily: 'inherit' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={!agentId ? 'text-accent-bright' : 'text-text-3/60'}>
              <circle cx="12" cy="12" r="10" />
              <line x1="2" y1="12" x2="22" y2="12" />
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
            Global
          </button>
          {agentList.map((agent) => (
            <button
              key={agent.id}
              onClick={() => setAgentId(agent.id)}
              className={`flex items-center gap-2 px-3 py-2 rounded-[10px] text-[13px] font-600 cursor-pointer transition-all border
                ${agentId === agent.id
                  ? 'bg-accent-soft border-accent-bright/20 text-accent-bright'
                  : 'bg-white/[0.02] border-white/[0.06] text-text-3 hover:text-text-2 hover:bg-white/[0.04]'}`}
              style={{ fontFamily: 'inherit' }}
            >
              <AgentAvatar seed={agent.avatarSeed || null} avatarUrl={agent.avatarUrl} name={agent.name} size={20} />
              <span className="truncate max-w-[120px]">{agent.name}</span>
            </button>
          ))}
        </div>
        {selectedAgent && (
          <p className="text-[11px] text-text-3/50 mt-2">
            Owned by <span className="text-text-2">{selectedAgent.name}</span>. Add collaborators below if other agents should be able to recall it too.
          </p>
        )}
        {!agentId && (
          <p className="text-[11px] text-text-3/50 mt-2">
            Global memories are accessible to every agent in the workspace.
          </p>
        )}
      </div>

      {/* Share with (only when assigned to an agent) */}
      {agentId && agentList.filter((a) => a.id !== agentId).length > 0 && (
        <div className="mb-6">
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Share with</label>
          <div className="flex gap-2 flex-wrap">
            {agentList
              .filter((a) => a.id !== agentId)
              .map((agent) => {
                const isShared = sharedWith.includes(agent.id)
                return (
                  <button
                    key={agent.id}
                    onClick={() => setSharedWith(isShared ? sharedWith.filter((id) => id !== agent.id) : [...sharedWith, agent.id])}
                    className={`flex items-center gap-2 px-3 py-2 rounded-[10px] text-[13px] font-600 cursor-pointer transition-all border
                      ${isShared
                        ? 'bg-accent-soft border-accent-bright/20 text-accent-bright'
                        : 'bg-white/[0.02] border-white/[0.06] text-text-3 hover:text-text-2 hover:bg-white/[0.04]'}`}
                    style={{ fontFamily: 'inherit' }}
                  >
                    <AgentAvatar seed={agent.avatarSeed || null} avatarUrl={agent.avatarUrl} name={agent.name} size={20} />
                    <span className="truncate max-w-[120px]">{agent.name}</span>
                  </button>
                )
              })}
          </div>
          {sharedWith.length > 0 && (
            <p className="text-[11px] text-text-3/50 mt-2">
              Shared with {sharedWith.length} agent{sharedWith.length === 1 ? '' : 's'} in addition to the owner
            </p>
          )}
        </div>
      )}

      {/* Title */}
      <div className="mb-6">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Title</label>
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Memory title" className={inputClass} style={{ fontFamily: 'inherit' }} />
      </div>

      {/* Category */}
      <div className="mb-6">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Category</label>
        <div className="flex gap-1.5 flex-wrap">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              onClick={() => {
                setCategory(c)
                setTier(getMemoryTierForCategory(c))
              }}
              className={`px-3 py-1.5 rounded-[8px] text-[12px] font-600 capitalize cursor-pointer transition-all border-none
                ${category === c
                  ? 'bg-accent-soft text-accent-bright'
                  : 'bg-white/[0.03] text-text-3 hover:text-text-2 hover:bg-white/[0.05]'}`}
              style={{ fontFamily: 'inherit' }}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-6">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Tier</label>
        <select
          value={tier}
          onChange={(e) => setTier(e.target.value as typeof tier)}
          className={inputClass}
          style={{ fontFamily: 'inherit' }}
        >
          <option value="working">Working: short-horizon, active context</option>
          <option value="durable">Durable: keep this around as reusable knowledge</option>
          <option value="archive">Archive: preserve, but keep less salient</option>
        </select>
        <p className="text-[11px] text-text-3/50 mt-2">
          Tier controls how aggressively this memory should stay in active recall.
        </p>
      </div>

      {/* Content */}
      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3">Content</label>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Memory content..."
          rows={6}
          className={`${inputClass} resize-y min-h-[150px]`}
          style={{ fontFamily: 'inherit' }}
        />
      </div>

      <SheetFooter
        onCancel={onClose}
        onSave={handleSave}
        saveLabel={saving ? 'Saving...' : 'Save'}
        saveDisabled={!title.trim() || saving}
      />
    </BottomSheet>
  )
}
