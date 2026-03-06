export function isHeartbeatSource(source: string | null | undefined): boolean {
  return source === 'heartbeat' || source === 'heartbeat-wake'
}

export function isInternalHeartbeatRun(internal: boolean | null | undefined, source: string | null | undefined): boolean {
  return internal === true && isHeartbeatSource(source)
}
