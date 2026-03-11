import { spawn } from 'node:child_process'

export interface DockerExecResult {
  code: number
  stdout: string
  stderr: string
}

function createDockerError(message: string, result: DockerExecResult): Error {
  return new Error(result.stderr.trim() || result.stdout.trim() || message)
}

export async function execDocker(args: string[], allowFailure = false): Promise<DockerExecResult> {
  return await new Promise<DockerExecResult>((resolve, reject) => {
    const child = spawn('docker', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      const result: DockerExecResult = {
        code: code ?? 0,
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
      }
      if (result.code !== 0 && !allowFailure) {
        reject(createDockerError(`docker ${args.join(' ')} failed`, result))
        return
      }
      resolve(result)
    })
  })
}

export async function inspectDockerContainer(containerName: string): Promise<{
  exists: boolean
  running: boolean
}> {
  const result = await execDocker([
    'inspect',
    '-f',
    '{{.State.Running}}',
    containerName,
  ], true)

  if (result.code !== 0) {
    return { exists: false, running: false }
  }

  return {
    exists: true,
    running: result.stdout.trim() === 'true',
  }
}

export async function readDockerLabel(containerName: string, label: string): Promise<string | null> {
  const result = await execDocker([
    'inspect',
    '-f',
    `{{ index .Config.Labels ${JSON.stringify(label)} }}`,
    containerName,
  ], true)

  if (result.code !== 0) return null
  const value = result.stdout.trim()
  if (!value || value === '<no value>') return null
  return value
}

export async function readDockerEnvVar(containerName: string, envKey: string): Promise<string | null> {
  const result = await execDocker([
    'inspect',
    '-f',
    `{{range .Config.Env}}{{println .}}{{end}}`,
    containerName,
  ], true)

  if (result.code !== 0) return null
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.startsWith(`${envKey}=`)) continue
    return line.slice(envKey.length + 1).trim() || null
  }
  return null
}

export async function readDockerPort(containerName: string, privatePort: number): Promise<number | null> {
  const result = await execDocker([
    'port',
    containerName,
    `${privatePort}/tcp`,
  ], true)

  if (result.code !== 0) return null
  const first = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
  if (!first) return null
  const match = first.match(/:(\d+)\s*$/)
  if (!match) return null
  const parsed = Number.parseInt(match[1], 10)
  return Number.isFinite(parsed) ? parsed : null
}
