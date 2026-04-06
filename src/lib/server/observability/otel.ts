import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { log } from '@/lib/server/logger'
import { hmrSingleton } from '@/lib/shared-utils'
import { resolveOtelConfig } from '@/lib/server/observability/otel-config'

const TAG = 'otel'

interface OTelState {
  started: boolean
  startPromise: Promise<boolean> | null
  sdk: NodeSDK | null
}

const otelState = hmrSingleton<OTelState>('__swarmclaw_otel_state__', () => ({
  started: false,
  startPromise: null,
  sdk: null,
}))

export function isOtelEnabled(): boolean {
  return resolveOtelConfig() !== null
}

export async function ensureOpenTelemetryStarted(): Promise<boolean> {
  const config = resolveOtelConfig()
  if (!config) return false
  if (otelState.started) return true
  if (otelState.startPromise) return otelState.startPromise

  otelState.startPromise = (async () => {
    try {
      process.env.OTEL_SERVICE_NAME = process.env.OTEL_SERVICE_NAME || config.serviceName
      const exporter = new OTLPTraceExporter({
        url: config.tracesEndpoint,
        headers: Object.keys(config.headers).length > 0 ? config.headers : undefined,
      })
      const sdk = new NodeSDK({
        traceExporter: exporter,
      })
      sdk.start()
      otelState.sdk = sdk
      otelState.started = true
      log.info(TAG, 'OpenTelemetry OTLP tracing enabled', {
        serviceName: config.serviceName,
        tracesEndpoint: config.tracesEndpoint,
      })
      return true
    } catch (err) {
      otelState.sdk = null
      otelState.started = false
      log.error(TAG, 'Failed to initialize OpenTelemetry tracing', err)
      return false
    } finally {
      otelState.startPromise = null
    }
  })()

  return otelState.startPromise
}

export async function shutdownOpenTelemetry(): Promise<void> {
  const sdk = otelState.sdk
  if (!sdk) {
    otelState.started = false
    otelState.startPromise = null
    return
  }

  otelState.sdk = null
  otelState.started = false
  otelState.startPromise = null

  try {
    await sdk.shutdown()
  } catch (err) {
    log.warn(TAG, 'Failed to flush OpenTelemetry tracing during shutdown', err)
  }
}
