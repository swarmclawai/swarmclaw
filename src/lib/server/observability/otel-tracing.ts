import {
  trace,
  SpanStatusCode,
  type Attributes,
  type AttributeValue,
  type Span,
} from '@opentelemetry/api'
import { errorMessage } from '@/lib/shared-utils'

type SpanAttributeInput = Record<string, AttributeValue | null | undefined>

function sanitizeAttributes(attributes?: SpanAttributeInput): Attributes | undefined {
  if (!attributes) return undefined
  const cleaned: Attributes = {}
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue
    cleaned[key] = value
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined
}

export function setSpanAttributes(span: Span, attributes?: SpanAttributeInput): void {
  const cleaned = sanitizeAttributes(attributes)
  if (!cleaned) return
  span.setAttributes(cleaned)
}

export function recordSpanError(span: Span, err: unknown): void {
  span.recordException(err instanceof Error ? err : new Error(errorMessage(err)))
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: errorMessage(err),
  })
}

export async function withServerSpan<T>(
  name: string,
  attributes: SpanAttributeInput | undefined,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  const tracer = trace.getTracer('swarmclaw.runtime')
  return tracer.startActiveSpan(name, { attributes: sanitizeAttributes(attributes) }, async (span) => {
    try {
      return await fn(span)
    } catch (err) {
      recordSpanError(span, err)
      throw err
    } finally {
      span.end()
    }
  })
}
