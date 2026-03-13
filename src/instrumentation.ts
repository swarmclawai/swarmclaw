import { hmrSingleton } from '@/lib/shared-utils'

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const isWorkerOnly = process.env.SWARMCLAW_WORKER_ONLY === '1'
    const { initWsServer, closeWsServer } = await import('./lib/server/ws-hub')
    const { ensureDaemonStarted } = await import('@/lib/server/runtime/daemon-state')
    
    // One-time migration: backfill allKnownPeerIds on existing connector sessions
    try {
      const { backfillAllKnownPeerIds, pruneThreadConnectorMirrors } = await import('@/lib/server/connectors/session-consolidation')
      backfillAllKnownPeerIds()
      pruneThreadConnectorMirrors()
    } catch (err) {
      console.error('[instrumentation] connector session consolidation failed:', err)
    }

    // In worker-only mode, we FORCE the daemon to start, but skip the WebSocket listener
    if (isWorkerOnly) {
      console.log('[instrumentation] Booting in WORKER ONLY mode')
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
      console.log(`[server] ${signal} received, shutting down gracefully...`)
      try {
        const { stopDaemon } = await import('@/lib/server/runtime/daemon-state')
        stopDaemon({ source: signal })
      } catch (err) {
        console.error('[instrumentation] Failed to stop daemon during shutdown:', err)
      }
      if (!isWorkerOnly) {
        await closeWsServer()
      }
      process.exit(0)
    }
    if (!shutdownState.registered) {
      process.on('SIGTERM', () => { void shutdown('SIGTERM') })
      process.on('SIGINT', () => { void shutdown('SIGINT') })
      shutdownState.registered = true
    }
  }
}
