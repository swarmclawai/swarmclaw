import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  parseOtelHeaders,
  resolveOtelConfig,
  resolveOtelTracesEndpoint,
} from '@/lib/server/observability/otel-config'

function env(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    ...overrides,
  }
}

describe('otel config', () => {
  it('stays disabled unless OTEL_ENABLED is truthy', () => {
    assert.equal(resolveOtelConfig(env({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' })), null)
  })

  it('normalizes a base OTLP endpoint to the traces path', () => {
    assert.equal(
      resolveOtelTracesEndpoint(env({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.com:4318',
      })),
      'https://collector.example.com:4318/v1/traces',
    )
  })

  it('prefers an explicit OTLP traces endpoint', () => {
    assert.equal(
      resolveOtelTracesEndpoint(env({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.com:4318',
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://collector.example.com/custom/traces',
      })),
      'https://collector.example.com/custom/traces',
    )
  })

  it('parses OTLP headers and applies the default service name', () => {
    const config = resolveOtelConfig(env({
      OTEL_ENABLED: 'true',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.com:4318',
      OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer token, X-Team = swarm ',
    }))

    assert.ok(config)
    assert.equal(config.serviceName, 'swarmclaw')
    assert.deepEqual(config.headers, {
      Authorization: 'Bearer token',
      'X-Team': 'swarm',
    })
    assert.equal(config.tracesEndpoint, 'https://collector.example.com:4318/v1/traces')
  })

  it('ignores malformed header entries', () => {
    assert.deepEqual(parseOtelHeaders('good=value, broken, =oops, missing='), {
      good: 'value',
    })
  })
})
