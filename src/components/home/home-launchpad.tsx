'use client'

import { AgentAvatar } from '@/components/agents/agent-avatar'
import { LaunchActionCard } from '@/components/shared/launch-action-card'
import type { Agent } from '@/types'

function SnapshotItem({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-[14px] border border-white/[0.06] bg-white/[0.03] px-4 py-3">
      <div className="text-[11px] font-700 uppercase tracking-[0.12em] text-text-3/55">{label}</div>
      <div className="mt-2 text-[24px] font-display font-700 tracking-[-0.03em] text-text">{value}</div>
      <div className="mt-1 text-[12px] leading-relaxed text-text-3/68">{hint}</div>
    </div>
  )
}

type Props = {
  firstAgent: Agent | null
  agentCount: number
  sessionCount: number
  taskCount: number
  scheduleCount: number
  connectorCount: number
  todayCost: number
  onOpenFirstAgent: () => void
  onOpenProtocols: () => void
  onOpenBuilder: () => void
  onOpenConnectors: () => void
  onOpenUsage: () => void
}

export function HomeLaunchpad({
  firstAgent,
  agentCount,
  sessionCount,
  taskCount,
  scheduleCount,
  connectorCount,
  todayCost,
  onOpenFirstAgent,
  onOpenProtocols,
  onOpenBuilder,
  onOpenConnectors,
  onOpenUsage,
}: Props) {
  return (
    <div className="max-w-[980px] mx-auto px-6 py-10">
      <div className="rounded-[24px] border border-white/[0.06] bg-gradient-to-br from-white/[0.05] via-white/[0.02] to-transparent p-6">
        <div className="inline-flex rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1 text-[11px] font-700 uppercase tracking-[0.16em] text-text-3/70">
          Launchpad
        </div>
        <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-[620px]">
            <h1 className="font-display text-[34px] font-700 tracking-[-0.03em] text-text">
              Start with the result you want, not the control plane.
            </h1>
            <p className="mt-3 text-[15px] leading-relaxed text-text-3/72">
              SwarmClaw already has the building blocks. Use this workspace to start a live agent chat, launch a bounded session, wire a connector, or move straight into reusable workflows.
            </p>
          </div>
          <div className="rounded-[18px] border border-white/[0.06] bg-white/[0.03] p-4 min-w-[240px]">
            <div className="text-[11px] font-700 uppercase tracking-[0.12em] text-text-3/55">Workspace Anchor</div>
            <div className="mt-3 flex items-center gap-3">
              {firstAgent ? (
                <>
                  <AgentAvatar
                    seed={firstAgent.avatarSeed}
                    avatarUrl={firstAgent.avatarUrl}
                    name={firstAgent.name}
                    size={44}
                  />
                  <div>
                    <div className="text-[14px] font-display font-700 text-text">{firstAgent.name}</div>
                    <div className="text-[12px] text-text-3/70">
                      {firstAgent.model ? firstAgent.model.split('/').pop()?.split(':')[0] : firstAgent.provider}
                    </div>
                  </div>
                </>
              ) : (
                <div className="text-[13px] leading-relaxed text-text-3/72">
                  No agents yet. Start by creating one or use the workflow tools first.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-6 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <LaunchActionCard
          title={firstAgent ? 'Open First Agent Chat' : 'Open Agents'}
          description={firstAgent
            ? `Jump into ${firstAgent.name} and start using the workspace immediately.`
            : 'Open the agents workspace to create or tune the first specialist agent.'}
          actionLabel={firstAgent ? 'Open Chat' : 'Open Agents'}
          onClick={onOpenFirstAgent}
          tone="primary"
        />
        <LaunchActionCard
          title="Start Structured Session"
          description="Open bounded collaboration runs for planning, review, decision-making, or focused multi-agent work."
          actionLabel="Open Protocols"
          onClick={onOpenProtocols}
        />
        <LaunchActionCard
          title="Open Workflow Builder"
          description="Move straight into reusable orchestration graphs if you want a durable workflow instead of a one-off run."
          actionLabel="Open Builder"
          onClick={onOpenBuilder}
        />
        <LaunchActionCard
          title="Connect a Platform"
          description="Bridge agents into chat surfaces like Discord, Slack, Telegram, and WhatsApp."
          actionLabel="Open Connectors"
          onClick={onOpenConnectors}
        />
        <LaunchActionCard
          title="Review Usage"
          description="Check cost, provider health, and activity so the workspace stays observable from the start."
          actionLabel="Open Usage"
          onClick={onOpenUsage}
        />
      </div>

      <div className="mt-8 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <SnapshotItem label="Agents" value={String(agentCount)} hint="Configured specialists available in this workspace." />
        <SnapshotItem label="Chats" value={String(sessionCount)} hint="Durable conversations already created." />
        <SnapshotItem label="Tasks" value={String(taskCount)} hint="Queued or archived work items in the board." />
        <SnapshotItem label="Schedules" value={String(scheduleCount)} hint="Recurring or delayed automations ready to run." />
        <SnapshotItem label="Connectors" value={String(connectorCount)} hint="Platform bridges currently configured." />
        <SnapshotItem label="Today's Cost" value={`$${todayCost.toFixed(2)}`} hint="Estimated usage cost for today across providers." />
      </div>
    </div>
  )
}
