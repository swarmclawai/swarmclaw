import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseTaskCompletion } from './delegation-banner'

describe('parseTaskCompletion', () => {
  it('extracts output files and report path from completion payload', () => {
    const text = [
      'Task completed: **[Build docs](#task:abc12345)**',
      '',
      'Working directory: `/tmp/work`',
      '',
      'Output files:',
      '- `docs/guide.md`',
      '- `docs/faq.md`',
      '',
      'Task report: `data/task-reports/abc12345.md`',
      '',
      'Done.',
    ].join('\n')
    const parsed = parseTaskCompletion(text)
    assert.ok(parsed)
    assert.deepEqual(parsed?.outputFiles, ['docs/guide.md', 'docs/faq.md'])
    assert.equal(parsed?.reportPath, 'data/task-reports/abc12345.md')
    assert.equal(parsed?.workingDir, '/tmp/work')
  })

  it('captures Gemini resume lines from task completion payloads', () => {
    const text = [
      'Task completed: **[Ship follow-up](#task:task-gemini)**',
      '',
      'Gemini session: `gemini-session-7`',
      '',
      'All done.',
    ].join('\n')
    const parsed = parseTaskCompletion(text)

    assert.ok(parsed)
    assert.equal(parsed?.resumeInfo, 'Gemini session: `gemini-session-7`')
  })
})
