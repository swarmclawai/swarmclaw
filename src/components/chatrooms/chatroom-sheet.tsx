'use client'

import { useState, useEffect } from 'react'
import { useChatroomStore } from '@/stores/use-chatroom-store'
import { useAppStore } from '@/stores/use-app-store'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import { toast } from 'sonner'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import type { Agent } from '@/types'
import { CheckIcon } from '@/components/shared/check-icon'

export function ChatroomSheet() {
  const open = useChatroomStore((s) => s.chatroomSheetOpen)
  const editingId = useChatroomStore((s) => s.editingChatroomId)
  const chatrooms = useChatroomStore((s) => s.chatrooms)
  const setChatroomSheetOpen = useChatroomStore((s) => s.setChatroomSheetOpen)
  const createChatroom = useChatroomStore((s) => s.createChatroom)
  const updateChatroom = useChatroomStore((s) => s.updateChatroom)
  const deleteChatroom = useChatroomStore((s) => s.deleteChatroom)
  const setCurrentChatroom = useChatroomStore((s) => s.setCurrentChatroom)
  const agents = useAppStore((s) => s.agents)

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([])
  const [chatMode, setChatMode] = useState<'sequential' | 'parallel'>('sequential')
  const [autoAddress, setAutoAddress] = useState(false)
  const [saving, setSaving] = useState(false)

  const editing = editingId ? chatrooms[editingId] : null

  useEffect(() => {
    if (editing) {
      setName(editing.name)
      setDescription(editing.description || '')
      setSelectedAgentIds([...editing.agentIds])
      setChatMode(editing.chatMode || 'sequential')
      setAutoAddress(editing.autoAddress || false)
    } else {
      setName('')
      setDescription('')
      setSelectedAgentIds([])
      setChatMode('sequential')
      setAutoAddress(false)
    }
  }, [editing, open])

  const handleSave = async () => {
    if (!name.trim() || saving) return
    setSaving(true)
    try {
      if (editing) {
        await updateChatroom(editing.id, { name, description, agentIds: selectedAgentIds, chatMode, autoAddress })
        toast.success('Chatroom saved')
      } else {
        const chatroom = await createChatroom({ name, description, agentIds: selectedAgentIds, chatMode, autoAddress })
        setCurrentChatroom(chatroom.id)
        toast.success('Chatroom created')
      }
      setChatroomSheetOpen(false)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!editing || saving) return
    setSaving(true)
    try {
      await deleteChatroom(editing.id)
      toast.success('Chatroom deleted')
      setChatroomSheetOpen(false)
    } finally {
      setSaving(false)
    }
  }

  const toggleAgent = (agentId: string) => {
    setSelectedAgentIds((prev) =>
      prev.includes(agentId) ? prev.filter((id) => id !== agentId) : [...prev, agentId]
    )
  }

  const agentList = Object.values(agents).filter(
    (a: Agent) => !a.trashedAt
  ) as Agent[]

  return (
    <BottomSheet open={open} onClose={() => setChatroomSheetOpen(false)}>
      <div className="p-6 max-w-[560px] mx-auto">
        <h2 className="font-display text-[18px] font-700 text-text mb-4">
          {editing ? 'Edit Chatroom' : 'Create Chatroom'}
        </h2>

        <div className="space-y-4">
          <div>
            <label className="block text-[12px] font-600 text-text-2 mb-1.5">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Research Team"
              className="w-full px-3 py-2 rounded-[8px] bg-white/[0.06] border border-white/[0.08] text-[13px] text-text placeholder:text-text-3 focus:outline-none focus:border-accent-bright/40"
            />
          </div>

          <div>
            <label className="block text-[12px] font-600 text-text-2 mb-1.5">Description</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description"
              className="w-full px-3 py-2 rounded-[8px] bg-white/[0.06] border border-white/[0.08] text-[13px] text-text placeholder:text-text-3 focus:outline-none focus:border-accent-bright/40"
            />
          </div>

          <div>
            <label className="block text-[12px] font-600 text-text-2 mb-1.5">Response Mode</label>
            <div className="flex rounded-[8px] border border-white/[0.08] overflow-hidden">
              {(['sequential', 'parallel'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setChatMode(mode)}
                  className={`flex-1 py-2 text-[12px] font-600 capitalize cursor-pointer transition-all ${
                    chatMode === mode
                      ? 'bg-accent-soft text-accent-bright'
                      : 'bg-transparent text-text-3 hover:text-text-2'
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-text-3 mt-1">
              {chatMode === 'parallel'
                ? 'All mentioned agents respond simultaneously'
                : 'Agents respond one at a time in order'}
            </p>
          </div>

          <div>
            <button
              type="button"
              onClick={() => setAutoAddress((v) => !v)}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-[8px] border border-white/[0.08] bg-white/[0.03] cursor-pointer transition-all hover:bg-white/[0.05]"
            >
              <div className={`w-8 h-[18px] rounded-full transition-all relative ${autoAddress ? 'bg-accent-bright' : 'bg-white/[0.12]'}`}>
                <div className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white transition-all ${autoAddress ? 'left-[16px]' : 'left-[2px]'}`} />
              </div>
              <div className="flex-1 text-left">
                <span className="text-[12px] font-600 text-text-2">Auto-address all agents</span>
                <p className="text-[11px] text-text-3 mt-0.5">
                  {autoAddress
                    ? 'Every message is sent to all agents, no @mention needed'
                    : 'Only agents you @mention will respond'}
                </p>
              </div>
            </button>
          </div>

          <div>
            <label className="block text-[12px] font-600 text-text-2 mb-1.5">
              Members ({selectedAgentIds.length} selected)
            </label>
            <div className="max-h-[240px] overflow-y-auto rounded-[8px] border border-white/[0.08] bg-white/[0.03]">
              {agentList.length === 0 ? (
                <p className="p-3 text-[12px] text-text-3">No agents available</p>
              ) : (
                agentList.map((agent) => {
                  const selected = selectedAgentIds.includes(agent.id)
                  return (
                    <button
                      key={agent.id}
                      onClick={() => toggleAgent(agent.id)}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-all cursor-pointer ${
                        selected ? 'bg-accent-soft/40' : 'hover:bg-white/[0.04]'
                      }`}
                    >
                      <AgentAvatar seed={agent.avatarSeed} avatarUrl={agent.avatarUrl} name={agent.name} size={24} />
                      <span className="text-[13px] text-text flex-1 truncate">{agent.name}</span>
                      {selected && (
                        <CheckIcon size={14} className="text-accent-bright shrink-0" />
                      )}
                    </button>
                  )
                })
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 mt-6">
          <button
            onClick={handleSave}
            disabled={!name.trim() || saving}
            className="flex-1 py-2.5 rounded-[8px] text-[13px] font-600 bg-accent-bright text-white hover:bg-accent-bright/90 transition-all disabled:opacity-50 cursor-pointer"
          >
            {saving ? 'Saving...' : editing ? 'Save Changes' : 'Create Chatroom'}
          </button>
          {editing && (
            <button
              onClick={handleDelete}
              disabled={saving}
              className="py-2.5 px-4 rounded-[8px] text-[13px] font-600 text-red-400 hover:bg-red-500/10 transition-all cursor-pointer"
            >
              Delete
            </button>
          )}
        </div>
      </div>
    </BottomSheet>
  )
}
