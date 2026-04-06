'use client'

import { LaunchActionCard } from '@/components/shared/launch-action-card'
import type { StepNextProps } from './types'
import { StepShell } from './shared'

export function StepNext({
  createdAgents,
  onContinueToDashboard,
  onOpenFirstAgent,
  onOpenProtocols,
  onOpenBuilder,
  onOpenConnectors,
  onOpenUsage,
}: StepNextProps) {
  const firstAgent = createdAgents[0] || null

  return (
    <StepShell wide>
      <h1 className="font-display text-[36px] font-800 leading-[1.05] tracking-[-0.04em] mb-3">
        Launch Your Workspace
      </h1>
      <p className="text-[15px] text-text-2 mb-2">
        Setup is complete. Start from the path that gets you to an actual result fastest.
      </p>
      <p className="text-[13px] text-text-3 mb-7">
        {firstAgent
          ? `${firstAgent.name} is ready to use.`
          : 'You finished setup without starter agents, so the launch options below focus on wiring up the rest of the workspace.'}
      </p>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 mb-8">
        <LaunchActionCard
          title={firstAgent ? 'Open First Agent Chat' : 'Open Agents'}
          description={firstAgent
            ? `Jump straight into ${firstAgent.name} and start working from the workspace you just created.`
            : 'Open the agents workspace so you can create or tune the first agent manually.'}
          actionLabel={firstAgent ? 'Open Chat' : 'Open Agents'}
          onClick={onOpenFirstAgent}
          tone="primary"
        />
        <LaunchActionCard
          title="Start Structured Session"
          description="Open bounded collaboration runs for reviews, planning rounds, decision-making, or focused multi-agent work."
          actionLabel="Open Protocols"
          onClick={onOpenProtocols}
        />
        <LaunchActionCard
          title="Open Workflow Builder"
          description="Jump into the visual protocol builder if you want a reusable orchestration graph instead of a one-off run."
          actionLabel="Open Builder"
          onClick={onOpenBuilder}
        />
        <LaunchActionCard
          title="Connect a Platform"
          description="Bridge agents into Discord, Slack, Telegram, WhatsApp, or other runtime connectors."
          actionLabel="Open Connectors"
          onClick={onOpenConnectors}
        />
        <LaunchActionCard
          title="Review Usage"
          description="Inspect cost, provider health, and agent activity so the workspace stays observable from day one."
          actionLabel="Open Usage"
          onClick={onOpenUsage}
        />
        <LaunchActionCard
          title="Go to Dashboard"
          description="Land on the main home view. Fresh workspaces open in guided launch mode before switching to the normal ops dashboard."
          actionLabel="Open Home"
          onClick={onContinueToDashboard}
        />
      </div>

      <button
        type="button"
        onClick={onContinueToDashboard}
        className="px-10 py-3.5 rounded-[14px] border-none bg-accent-bright text-white text-[15px] font-display font-600 cursor-pointer hover:brightness-110 active:scale-[0.97] transition-all duration-200 shadow-[0_6px_28px_rgba(99,102,241,0.3)]"
      >
        Continue to Dashboard
      </button>
    </StepShell>
  )
}
