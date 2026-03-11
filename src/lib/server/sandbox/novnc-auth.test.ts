import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildNoVncObserverTokenUrl,
  consumeNoVncObserverToken,
  generateNoVncPassword,
  issueNoVncObserverToken,
} from '@/lib/server/sandbox/novnc-auth'

test('noVNC auth issues single-use observer tokens', () => {
  const token = issueNoVncObserverToken({
    noVncPort: 46080,
    password: 'secret123',
  })

  const first = consumeNoVncObserverToken(token)
  const second = consumeNoVncObserverToken(token)

  assert.equal(first?.noVncPort, 46080)
  assert.equal(first?.password, 'secret123')
  assert.equal(second, null)
})

test('noVNC helper builds loopback observer urls', () => {
  const url = buildNoVncObserverTokenUrl('http://127.0.0.1:41234', 'token-123')
  assert.equal(url, 'http://127.0.0.1:41234/sandbox/novnc?token=token-123')
  assert.equal(generateNoVncPassword().length, 8)
})
