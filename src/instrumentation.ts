export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startScheduler } = await import('./lib/server/scheduler')
    const { resumeQueue } = await import('./lib/server/queue')
    const { initWsServer } = await import('./lib/server/ws-hub')
    startScheduler()
    resumeQueue()
    initWsServer()
  }
}
