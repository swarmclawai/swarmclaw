/**
 * Helpers for reasoning about who owns a runtime lease.
 *
 * Owner strings have the shape `pid:${pid}:${suffix}` (see
 * `runtime/daemon-state/core.ts` where the suffix is generated). When the
 * holding process disappears without releasing the lease (container crash,
 * SIGKILL), a successor instance has no way to know the lease is stale
 * other than waiting out the TTL. These helpers let the successor detect
 * that the recorded pid is no longer alive and reclaim the lease.
 *
 * The reclaim path is intentionally conservative: any uncertainty (owner
 * string format we do not recognise, probe outcome we cannot interpret,
 * etc.) returns `false` so the caller falls back to "wait for TTL".
 *
 * Single-host only. If a lease was acquired on a different host (Kubernetes
 * multi-pod), the recorded pid means nothing here. Recognising "different
 * host" requires the owner string itself to encode a host id, which we do
 * not currently do; for now, mixed-host deployments will continue to wait
 * out the TTL, which is the correct behavior in the absence of a way to
 * verify the remote process status.
 */

const OWNER_PATTERN = /^pid:(\d+):/

export interface ProcessProbe {
  /** Sends signal 0 to the pid, throws on error like `process.kill`. */
  kill: (pid: number, signal: 0) => true | void
}

const realProbe: ProcessProbe = {
  kill: (pid, signal) => {
    process.kill(pid, signal)
    return true
  },
}

export function parseOwnerPid(owner: string | null | undefined): number | null {
  if (typeof owner !== 'string') return null
  const match = owner.match(OWNER_PATTERN)
  if (!match) return null
  const pid = Number(match[1])
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

/**
 * Returns true when the recorded owner pid is provably dead on this host.
 * Returns false for any other outcome:
 *   - owner string we cannot parse
 *   - probe succeeded (the process is alive)
 *   - probe failed with EPERM (process exists but is owned by someone
 *     else; treat as "alive, do not steal")
 *   - any other unexpected failure (do not guess)
 *
 * `probe` is injectable for tests.
 */
export function isOwnerProcessDead(owner: string | null | undefined, probe: ProcessProbe = realProbe): boolean {
  const pid = parseOwnerPid(owner)
  if (pid === null) return false
  if (pid === process.pid) return false
  try {
    probe.kill(pid, 0)
    return false
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ESRCH') return true
    return false
  }
}
