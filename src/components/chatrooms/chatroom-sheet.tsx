'use client'

import { useState, useEffect } from 'react'
import { useChatroomStore } from '@/stores/use-chatroom-store'
import { useAppStore } from '@/stores/use-app-store'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import { toast } from 'sonner'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import type { Agent, ChatroomRoutingRule } from '@/types'
import { CheckIcon } from '@/components/shared/check-icon'

function genRuleId(): string {
  return `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

interface RuleFormState {
  type: 'keyword' | 'capability'
  pattern: string
  keywords: string
  agentId: string
  priority: number
}

const emptyRuleForm: RuleFormState = {
  type: 'keyword',
  pattern: '',
  keywords: '',
  agentId: '',
  priority: 10,
}

function RoutingRuleForm({
  rule,
  memberAgents,
  onSave,
  onCancel,
}: {
  rule: RuleFormState
  memberAgents: Agent[]
  onSave: (form: RuleFormState) => void
  onCancel: () => void
}) {
  const [form, setForm] = useState<RuleFormState>(rule)

  return (
    <div className="p-3 rounded-[8px] bg-white/[0.04] border border-white/[0.08] space-y-3">
      <div className="flex gap-2">
        {(['keyword', 'capability'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setForm((f) => ({ ...f, type: t }))}
            className={`flex-1 py-1.5 text-[11px] font-600 capitalize rounded-[6px] cursor-pointer transition-all ${
              form.type === t
                ? 'bg-accent-soft text-accent-bright'
                : 'bg-white/[0.04] text-text-3 hover:text-text-2'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {form.type === 'keyword' && (
        <>
          <div>
            <label className="block text-[11px] font-600 text-text-3 mb-1">Keywords (comma-separated)</label>
            <input
              type="text"
              value={form.keywords}
              onChange={(e) => setForm((f) => ({ ...f, keywords: e.target.value }))}
              placeholder="e.g. deploy, devops, infrastructure"
              className="w-full px-2.5 py-1.5 rounded-[6px] bg-white/[0.06] border border-white/[0.08] text-[12px] text-text placeholder:text-text-3 focus:outline-none focus:border-accent-bright/40"
            />
          </div>
          <div>
            <label className="block text-[11px] font-600 text-text-3 mb-1">Regex pattern (optional)</label>
            <input
              type="text"
              value={form.pattern}
              onChange={(e) => setForm((f) => ({ ...f, pattern: e.target.value }))}
              placeholder="e.g. deploy|release|ship"
              className="w-full px-2.5 py-1.5 rounded-[6px] bg-white/[0.06] border border-white/[0.08] text-[12px] text-text placeholder:text-text-3 focus:outline-none focus:border-accent-bright/40"
            />
          </div>
        </>
      )}

      {form.type === 'capability' && (
        <div>
          <label className="block text-[11px] font-600 text-text-3 mb-1">Capability pattern</label>
          <input
            type="text"
            value={form.pattern}
            onChange={(e) => setForm((f) => ({ ...f, pattern: e.target.value }))}
            placeholder="e.g. frontend, research, devops"
            className="w-full px-2.5 py-1.5 rounded-[6px] bg-white/[0.06] border border-white/[0.08] text-[12px] text-text placeholder:text-text-3 focus:outline-none focus:border-accent-bright/40"
          />
        </div>
      )}

      <div className="flex gap-2">
        <div className="flex-1">
          <label className="block text-[11px] font-600 text-text-3 mb-1">Route to agent</label>
          <select
            value={form.agentId}
            onChange={(e) => setForm((f) => ({ ...f, agentId: e.target.value }))}
            className="w-full px-2.5 py-1.5 rounded-[6px] bg-white/[0.06] border border-white/[0.08] text-[12px] text-text focus:outline-none focus:border-accent-bright/40"
          >
            <option value="">Select agent...</option>
            {memberAgents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>
        <div className="w-20">
          <label className="block text-[11px] font-600 text-text-3 mb-1">Priority</label>
          <input
            type="number"
            value={form.priority}
            onChange={(e) => setForm((f) => ({ ...f, priority: parseInt(e.target.value, 10) || 0 }))}
            className="w-full px-2.5 py-1.5 rounded-[6px] bg-white/[0.06] border border-white/[0.08] text-[12px] text-text focus:outline-none focus:border-accent-bright/40"
          />
        </div>
      </div>

      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-[11px] font-600 text-text-3 hover:text-text-2 cursor-pointer"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onSave(form)}
          disabled={!form.agentId || (form.type === 'keyword' && !form.keywords.trim() && !form.pattern.trim()) || (form.type === 'capability' && !form.pattern.trim())}
          className="px-3 py-1.5 text-[11px] font-600 bg-accent-bright text-white rounded-[6px] hover:bg-accent-bright/90 disabled:opacity-50 cursor-pointer"
        >
          Save Rule
        </button>
      </div>
    </div>
  )
}

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
  const [routingRules, setRoutingRules] = useState<ChatroomRoutingRule[]>([])
  const [saving, setSaving] = useState(false)
  const [addingRule, setAddingRule] = useState(false)
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null)

  const editing = editingId ? chatrooms[editingId] : null

  useEffect(() => {
    if (editing) {
      setName(editing.name)
      setDescription(editing.description || '')
      setSelectedAgentIds([...editing.agentIds])
      setChatMode(editing.chatMode || 'sequential')
      setAutoAddress(editing.autoAddress || false)
      setRoutingRules([...(editing.routingRules || [])])
    } else {
      setName('')
      setDescription('')
      setSelectedAgentIds([])
      setChatMode('sequential')
      setAutoAddress(false)
      setRoutingRules([])
    }
    setAddingRule(false)
    setEditingRuleId(null)
  }, [editing, open])

  const handleSave = async () => {
    if (!name.trim() || saving) return
    setSaving(true)
    try {
      const payload = {
        name,
        description,
        agentIds: selectedAgentIds,
        chatMode,
        autoAddress,
        routingRules: routingRules.length > 0 ? routingRules : undefined,
      }
      if (editing) {
        await updateChatroom(editing.id, payload)
        toast.success('Chatroom updated successfully')
      } else {
        const chatroom = await createChatroom(payload)
        setCurrentChatroom(chatroom.id)
        toast.success('Chatroom created successfully')
      }
      setChatroomSheetOpen(false)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to save chatroom')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!editing || saving) return
    if (!confirm(`Delete chatroom "${editing.name}"?`)) return
    setSaving(true)
    try {
      await deleteChatroom(editing.id)
      toast.success('Chatroom deleted')
      setChatroomSheetOpen(false)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete chatroom')
    } finally {
      setSaving(false)
    }
  }

  const toggleAgent = (agentId: string) => {
    setSelectedAgentIds((prev) =>
      prev.includes(agentId) ? prev.filter((id) => id !== agentId) : [...prev, agentId]
    )
  }

  const handleAddRule = (form: RuleFormState) => {
    const rule: ChatroomRoutingRule = {
      id: genRuleId(),
      type: form.type,
      agentId: form.agentId,
      priority: form.priority,
      ...(form.pattern.trim() ? { pattern: form.pattern.trim() } : {}),
      ...(form.type === 'keyword' && form.keywords.trim()
        ? { keywords: form.keywords.split(',').map((k) => k.trim()).filter(Boolean) }
        : {}),
    }
    setRoutingRules((prev) => [...prev, rule].sort((a, b) => a.priority - b.priority))
    setAddingRule(false)
  }

  const handleEditRule = (form: RuleFormState) => {
    setRoutingRules((prev) =>
      prev.map((r) =>
        r.id === editingRuleId
          ? {
              ...r,
              type: form.type,
              agentId: form.agentId,
              priority: form.priority,
              pattern: form.pattern.trim() || undefined,
              keywords:
                form.type === 'keyword' && form.keywords.trim()
                  ? form.keywords.split(',').map((k) => k.trim()).filter(Boolean)
                  : undefined,
            }
          : r,
      ).sort((a, b) => a.priority - b.priority),
    )
    setEditingRuleId(null)
  }

  const removeRule = (ruleId: string) => {
    setRoutingRules((prev) => prev.filter((r) => r.id !== ruleId))
  }

  const agentList = Object.values(agents).filter(
    (a: Agent) => !a.trashedAt
  ) as Agent[]

  const memberAgents = agentList.filter((a) => selectedAgentIds.includes(a.id))
  const sortedRules = [...routingRules].sort((a, b) => a.priority - b.priority)

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

          {/* Routing Rules */}
          <div>
            <label className="block text-[12px] font-600 text-text-2 mb-1.5">
              Routing Rules ({sortedRules.length})
            </label>
            <p className="text-[11px] text-text-3 mb-2">
              Route messages to specific agents based on keywords or capabilities. Evaluated before auto-address.
            </p>

            {sortedRules.length > 0 && (
              <div className="space-y-2 mb-2">
                {sortedRules.map((rule) => {
                  const agent = agents[rule.agentId]
                  if (editingRuleId === rule.id) {
                    return (
                      <RoutingRuleForm
                        key={rule.id}
                        rule={{
                          type: rule.type,
                          pattern: rule.pattern || '',
                          keywords: rule.keywords?.join(', ') || '',
                          agentId: rule.agentId,
                          priority: rule.priority,
                        }}
                        memberAgents={memberAgents}
                        onSave={handleEditRule}
                        onCancel={() => setEditingRuleId(null)}
                      />
                    )
                  }
                  return (
                    <div
                      key={rule.id}
                      className="flex items-center gap-2 px-3 py-2 rounded-[8px] bg-white/[0.04] border border-white/[0.08]"
                    >
                      <span className="text-[10px] font-700 text-text-3 bg-white/[0.06] px-1.5 py-0.5 rounded">
                        P{rule.priority}
                      </span>
                      <span className="text-[10px] font-600 text-accent-bright/70 uppercase">
                        {rule.type}
                      </span>
                      <span className="text-[12px] text-text-2 flex-1 truncate">
                        {rule.type === 'keyword'
                          ? (rule.keywords?.join(', ') || rule.pattern || '(no match)')
                          : (rule.pattern || '(no pattern)')}
                      </span>
                      <span className="text-[11px] text-text-3 truncate max-w-[100px]">
                        {agent?.name || 'Unknown'}
                      </span>
                      <button
                        type="button"
                        onClick={() => setEditingRuleId(rule.id)}
                        className="text-[11px] text-text-3 hover:text-text-2 cursor-pointer px-1"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => removeRule(rule.id)}
                        className="text-[11px] text-red-400 hover:text-red-300 cursor-pointer px-1"
                      >
                        Remove
                      </button>
                    </div>
                  )
                })}
              </div>
            )}

            {addingRule ? (
              <RoutingRuleForm
                rule={emptyRuleForm}
                memberAgents={memberAgents}
                onSave={handleAddRule}
                onCancel={() => setAddingRule(false)}
              />
            ) : (
              <button
                type="button"
                onClick={() => setAddingRule(true)}
                disabled={memberAgents.length === 0}
                className="w-full py-2 rounded-[8px] border border-dashed border-white/[0.12] text-[12px] font-600 text-text-3 hover:text-text-2 hover:border-white/[0.2] cursor-pointer transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                + Add Rule
              </button>
            )}
            {memberAgents.length === 0 && (
              <p className="text-[11px] text-text-3 mt-1">Add members first to create routing rules.</p>
            )}
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
