export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { initWsServer, closeWsServer } = await import('./lib/server/ws-hub')
    const { ensureDaemonStarted } = await import('./lib/server/daemon-state')
    ensureDaemonStarted('instrumentation')

    initWsServer()

    // Graceful shutdown: stop background services and close WS connections
    const shutdownState = (
      (globalThis as Record<string, unknown>).__swarmclaw_shutdown_state__
      ??= { registered: false, shuttingDown: false }
    ) as { registered: boolean; shuttingDown: boolean }

    const shutdown = async (signal: string) => {
      if (shutdownState.shuttingDown) return
      shutdownState.shuttingDown = true
      console.log(`[server] ${signal} received, shutting down gracefully...`)
      try {
        const { stopDaemon } = await import('./lib/server/daemon-state')
        stopDaemon({ source: signal })
      } catch (err) {
        console.error('[instrumentation] Failed to stop daemon during shutdown:', err)
      }
      await closeWsServer()
      process.exit(0)
    }
    if (!shutdownState.registered) {
      process.on('SIGTERM', () => { void shutdown('SIGTERM') })
      process.on('SIGINT', () => { void shutdown('SIGINT') })
      shutdownState.registered = true
    }
  }
}
