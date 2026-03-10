import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { shouldSuppressHiddenControlText, stripHiddenControlTokens } from '@/lib/server/agents/assistant-control'

describe('assistant-control', () => {
  it('suppresses pure hidden control replies', () => {
    assert.equal(shouldSuppressHiddenControlText('NO_MESSAGE'), true)
    assert.equal(shouldSuppressHiddenControlText('  HEARTBEAT_OK  '), true)
    assert.equal(stripHiddenControlTokens('NO_MESSAGE'), '')
  })

  it('strips leaked control prefixes without suppressing real content', () => {
    assert.equal(
      stripHiddenControlTokens('NO_MESSAGEIt seems there was an error earlier on.'),
      'It seems there was an error earlier on.',
    )
    assert.equal(
      shouldSuppressHiddenControlText('NO_MESSAGEIt seems there was an error earlier on.'),
      false,
    )
  })

  it('removes standalone control-token lines from mixed content', () => {
    assert.equal(
      stripHiddenControlTokens('Working on it.\nNO_MESSAGE\nI found the issue.'),
      'Working on it.\nI found the issue.',
    )
  })
})
