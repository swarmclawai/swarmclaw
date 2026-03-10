import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { EventEmitter } from 'node:events'
import { getPluginManager } from '../plugins'
import { loadSettings, saveSettings } from '../storage'
import { executeGoogleWorkspaceAction } from './google-workspace'

function cloneSettings() {
  return JSON.parse(JSON.stringify(loadSettings() || {}))
}

const originalSettings = cloneSettings()

afterEach(() => {
  saveSettings(JSON.parse(JSON.stringify(originalSettings)))
})

describe('google_workspace tool', () => {
  it('loads settings through the standard plugin settings system', () => {
    getPluginManager().setPluginSettings('google_workspace', {
      accessToken: 'token-123',
      sanitizeMode: 'block',
      projectId: 'project-x',
    })

    const settings = getPluginManager().getPluginSettings('google_workspace')
    assert.equal(settings.accessToken, 'token-123')
    assert.equal(settings.sanitizeMode, 'block')
    assert.equal(settings.projectId, 'project-x')
  })

  it('returns a clear install error when gws is missing', async () => {
    const result = await executeGoogleWorkspaceAction(
      { args: ['drive', 'files', 'list'] },
      {
        findBinaryOnPath: () => null,
        spawn: (() => {
          throw new Error('spawn should not be called')
        }) as never,
        getConfig: () => ({
          accessToken: '',
          credentialsFile: '',
          credentialsJson: '',
          clientId: '',
          clientSecret: '',
          configDir: '',
          projectId: '',
          sanitizeTemplate: '',
          sanitizeMode: 'warn',
        }),
      },
    )

    assert.match(result, /gws` is not installed/i)
  })

  it('blocks interactive auth flows inside the tool', async () => {
    const result = await executeGoogleWorkspaceAction(
      { args: ['auth', 'login'] },
      {
        findBinaryOnPath: () => '/usr/local/bin/gws',
        spawn: (() => {
          throw new Error('spawn should not be called')
        }) as never,
        getConfig: () => ({
          accessToken: '',
          credentialsFile: '',
          credentialsJson: '',
          clientId: '',
          clientSecret: '',
          configDir: '',
          projectId: '',
          sanitizeTemplate: '',
          sanitizeMode: 'warn',
        }),
      },
    )

    assert.match(result, /interactive `gws auth login` \/ `gws auth setup` is not supported/i)
  })

  it('passes plugin settings through env and formats JSON output', async () => {
    let observedArgs: string[] = []
    let observedEnv: NodeJS.ProcessEnv | undefined

    const fakeSpawn = ((binary: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      assert.equal(binary, '/usr/local/bin/gws')
      observedArgs = args
      observedEnv = options.env

      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter
        stderr: EventEmitter
        stdin: { write: (chunk: string) => void; end: () => void }
      }
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.stdin = {
        write: () => {},
        end: () => {},
      }

      process.nextTick(() => {
        child.stdout.emit('data', Buffer.from('{"files":[{"id":"file-1","name":"Quarterly Plan"}]}'))
        child.emit('close', 0, null)
      })

      return child
    }) as never

    const result = await executeGoogleWorkspaceAction(
      {
        args: ['drive', 'files', 'list'],
        params: { pageSize: 2 },
        pageAll: true,
      },
      {
        cwd: '/tmp',
        findBinaryOnPath: () => '/usr/local/bin/gws',
        spawn: fakeSpawn,
        getConfig: () => ({
          accessToken: 'token-xyz',
          credentialsFile: '/tmp/creds.json',
          credentialsJson: '',
          clientId: 'client-id',
          clientSecret: 'client-secret',
          configDir: '/tmp/gws',
          projectId: 'project-1',
          sanitizeTemplate: 'projects/demo/templates/default',
          sanitizeMode: 'block',
        }),
      },
    )

    assert.deepEqual(observedArgs, [
      'drive',
      'files',
      'list',
      '--params',
      '{"pageSize":2}',
      '--page-all',
    ])
    assert.equal(observedEnv?.GOOGLE_WORKSPACE_CLI_TOKEN, 'token-xyz')
    assert.equal(observedEnv?.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE, '/tmp/creds.json')
    assert.equal(observedEnv?.GOOGLE_WORKSPACE_CLI_CLIENT_ID, 'client-id')
    assert.equal(observedEnv?.GOOGLE_WORKSPACE_CLI_CLIENT_SECRET, 'client-secret')
    assert.equal(observedEnv?.GOOGLE_WORKSPACE_CLI_CONFIG_DIR, '/tmp/gws')
    assert.equal(observedEnv?.GOOGLE_WORKSPACE_PROJECT_ID, 'project-1')
    assert.equal(observedEnv?.GOOGLE_WORKSPACE_CLI_SANITIZE_TEMPLATE, 'projects/demo/templates/default')
    assert.equal(observedEnv?.GOOGLE_WORKSPACE_CLI_SANITIZE_MODE, 'block')
    assert.match(result, /"Quarterly Plan"/)
  })
})
