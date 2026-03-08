import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { normalizeCanvasDocument } from './canvas-content'

describe('normalizeCanvasDocument', () => {
  it('filters invalid metric rows and keeps valid metrics blocks', () => {
    const result = normalizeCanvasDocument({
      title: 'Smoke',
      blocks: [
        {
          type: 'metrics',
          items: [
            { label: 'Healthy', value: 12, tone: 'positive' },
            { label: '', value: 'skip-me' },
            { value: 'missing-label' },
          ],
        },
      ],
    })

    assert.ok(result)
    assert.equal(result?.blocks.length, 1)
    assert.deepEqual(result?.blocks[0], {
      type: 'metrics',
      items: [
        { label: 'Healthy', value: '12', tone: 'positive', detail: undefined },
      ],
      title: undefined,
    })
  })
})
