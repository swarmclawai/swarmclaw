import { hmrSingleton } from '@/lib/shared-utils'

const TAG = 'instrumentation'

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { log } = await import('@/lib/server/logger')
    const { ensureOpenTelemetryStarted, shutdownOpenTelemetry } = await import('@/lib/server/observability/otel')
    const isWorkerOnly = process.env.SWARMCLAW_WORKER_ONLY === '1'
    const { initWsServer, closeWsServer } = await import('./lib/server/ws-hub')
    const { ensureDaemonStarted } = await import('@/lib/server/runtime/daemon-state')
    await ensureOpenTelemetryStarted()
    
    // One-time migration: backfill allKnownPeerIds on existing connector sessions
    try {
      const { backfillAllKnownPeerIds, pruneThreadConnectorMirrors } = await import('@/lib/server/connectors/session-consolidation')
      backfillAllKnownPeerIds()
      pruneThreadConnectorMirrors()
    } catch (err) {
      log.error(TAG, 'connector session consolidation failed:', err)
    }

    // In worker-only mode, we FORCE the daemon to start, but skip the WebSocket listener
    if (isWorkerOnly) {
      log.info(TAG, 'Booting in WORKER ONLY mode')
      ensureDaemonStarted('worker-boot')
    } else {
      // In normal mode, we start the WS server, and conditionally start the daemon if autostart allows
      initWsServer()
      ensureDaemonStarted('instrumentation')
    }

    // Graceful shutdown: stop background services and close WS connections
    const shutdownState = hmrSingleton('__swarmclaw_shutdown_state__', () => ({
      registered: false,
      shuttingDown: false,
    }))

    const shutdown = async (signal: string) => {
      if (shutdownState.shuttingDown) return
      shutdownState.shuttingDown = true
      log.info(TAG, `${signal} received, shutting down gracefully...`)
      try {
        const { stopDaemon } = await import('@/lib/server/runtime/daemon-state')
        await stopDaemon({ source: signal })
      } catch (err) {
        log.error(TAG, 'Failed to stop daemon during shutdown:', err)
      }
      try {
        await shutdownOpenTelemetry()
      } catch (err) {
        log.error(TAG, 'Failed to stop OpenTelemetry during shutdown:', err)
      }
      if (!isWorkerOnly) {
        await closeWsServer()
      }
      process.exit(0)
    }
    if (!shutdownState.registered) {
      process.on('SIGTERM', () => { void shutdown('SIGTERM') })
      process.on('SIGINT', () => { void shutdown('SIGINT') })

      // Gracefully handle EPIPE errors from child processes (e.g. Playwright MCP proxy)
      // that occur during dev server restarts when stdio pipes break
      process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EPIPE') {
          log.warn(TAG, 'Ignoring EPIPE (expected during dev server restart)')
          return
        }
        log.error(TAG, 'Uncaught exception:', err)
        process.exit(1)
      })

      // LangGraph's streamEvents leaves dangling internal promises when the
      // for-await loop exits early. Suppress expected LangGraph rejections;
      // log all others so they're not silently dropped.
      process.on('unhandledRejection', (err: unknown) => {
        if (
          err && typeof err === 'object'
          && ('pregelTaskId' in err
            || (err instanceof Error && (err.name === 'AbortError' || err.name === 'GraphRecursionError'))
            || (err as Record<string, unknown>).lc_error_code === 'GRAPH_RECURSION_LIMIT')
        ) {
          return
        }
        log.error(TAG, 'Unhandled rejection:', err)
      })

      shutdownState.registered = true
    }
  }
}
