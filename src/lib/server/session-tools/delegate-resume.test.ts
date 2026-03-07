import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveDelegateResumeConfig } from './delegate'

describe('resolveDelegateResumeConfig', () => {
  it('auto-resumes when a stored backend resume ID exists', () => {
    const config = resolveDelegateResumeConfig(
      { task: 'continue the implementation' },
      'codex',
      {
        readStoredDelegateResumeId: (key) => key === 'codex' ? 'codex-thread-42' : null,
      },
    )

    assert.deepEqual(config, {
      resume: true,
      resumeId: '',
    })
  })

  it('respects explicit resume=false even when a stored ID exists', () => {
    const config = resolveDelegateResumeConfig(
      { task: 'start fresh', resume: false },
      'claude',
      {
        readStoredDelegateResumeId: () => 'claude-session-99',
      },
    )

    assert.deepEqual(config, {
      resume: false,
      resumeId: '',
    })
  })

  it('treats an explicit resumeId as an instruction to resume immediately', () => {
    const config = resolveDelegateResumeConfig(
      { task: 'continue', resumeId: 'gemini-session-5' },
      'gemini',
      {
        readStoredDelegateResumeId: () => null,
      },
    )

    assert.deepEqual(config, {
      resume: true,
      resumeId: 'gemini-session-5',
    })
  })
})
