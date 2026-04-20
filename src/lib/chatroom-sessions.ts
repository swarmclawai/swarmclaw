export function resolveChatroomSyntheticSessionId(chatroomId: string, agentId: string): string {
  return `chatroom-${chatroomId}-${agentId}`
}

