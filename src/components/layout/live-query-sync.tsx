'use client'

import { useQueryClient } from '@tanstack/react-query'
import { useWs } from '@/hooks/use-ws'
import { agentQueryKeys } from '@/features/agents/queries'
import { taskQueryKeys } from '@/features/tasks/queries'
import { protocolQueryKeys } from '@/features/protocols/queries'
import { providerQueryKeys } from '@/features/providers/queries'
import { gatewayQueryKeys } from '@/features/gateways/queries'
import { externalAgentQueryKeys } from '@/features/external-agents/queries'
import { chatQueryKeys } from '@/features/chats/queries'
import { connectorQueryKeys } from '@/features/connectors/queries'
import { skillQueryKeys, skillSuggestionQueryKeys } from '@/features/skills/queries'

function LiveQueryTopicSubscription({
  topic,
  fallbackMs,
  onEvent,
}: {
  topic: string
  fallbackMs?: number
  onEvent: () => void
}) {
  useWs(topic, onEvent, fallbackMs)
  return null
}

export function LiveQuerySync() {
  const queryClient = useQueryClient()

  return (
    <>
      <LiveQueryTopicSubscription
        topic="agents"
        fallbackMs={60_000}
        onEvent={() => {
          void queryClient.invalidateQueries({ queryKey: agentQueryKeys.all })
        }}
      />
      <LiveQueryTopicSubscription
        topic="tasks"
        fallbackMs={5_000}
        onEvent={() => {
          void queryClient.invalidateQueries({ queryKey: taskQueryKeys.all })
        }}
      />
      <LiveQueryTopicSubscription
        topic="protocol_runs"
        fallbackMs={2_000}
        onEvent={() => {
          void queryClient.invalidateQueries({ queryKey: protocolQueryKeys.all })
        }}
      />
      <LiveQueryTopicSubscription
        topic="protocol_templates"
        fallbackMs={2_000}
        onEvent={() => {
          void queryClient.invalidateQueries({ queryKey: protocolQueryKeys.templates() })
        }}
      />
      <LiveQueryTopicSubscription
        topic="providers"
        fallbackMs={20_000}
        onEvent={() => {
          void queryClient.invalidateQueries({ queryKey: providerQueryKeys.all })
        }}
      />
      <LiveQueryTopicSubscription
        topic="gateways"
        fallbackMs={20_000}
        onEvent={() => {
          void queryClient.invalidateQueries({ queryKey: gatewayQueryKeys.all })
        }}
      />
      <LiveQueryTopicSubscription
        topic="external_agents"
        fallbackMs={20_000}
        onEvent={() => {
          void queryClient.invalidateQueries({ queryKey: externalAgentQueryKeys.all })
        }}
      />
      <LiveQueryTopicSubscription
        topic="connectors"
        fallbackMs={15_000}
        onEvent={() => {
          void queryClient.invalidateQueries({ queryKey: connectorQueryKeys.all })
        }}
      />
      <LiveQueryTopicSubscription
        topic="sessions"
        fallbackMs={15_000}
        onEvent={() => {
          void queryClient.invalidateQueries({ queryKey: chatQueryKeys.all })
        }}
      />
      <LiveQueryTopicSubscription
        topic="messages"
        fallbackMs={5_000}
        onEvent={() => {
          void queryClient.invalidateQueries({
            predicate: (q) => q.queryKey[0] === 'chats' && q.queryKey[2] === 'messages',
          })
        }}
      />
      <LiveQueryTopicSubscription
        topic="skills"
        fallbackMs={20_000}
        onEvent={() => {
          void queryClient.invalidateQueries({ queryKey: skillQueryKeys.all })
        }}
      />
      <LiveQueryTopicSubscription
        topic="skill_suggestions"
        fallbackMs={20_000}
        onEvent={() => {
          void queryClient.invalidateQueries({ queryKey: skillSuggestionQueryKeys.all })
        }}
      />
    </>
  )
}
