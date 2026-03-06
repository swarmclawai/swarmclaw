import { NextResponse } from 'next/server'
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'

export async function POST(req: Request) {
  const { path: targetPath } = await req.json() as { path?: string }
  if (!targetPath || typeof targetPath !== 'string') {
    return NextResponse.json({ error: 'path is required' }, { status: 400 })
  }

  const resolved = path.resolve(targetPath)

  // Verify the path exists
  if (!fs.existsSync(resolved)) {
    return NextResponse.json({ error: 'Path does not exist' }, { status: 404 })
  }

  const isDir = fs.statSync(resolved).isDirectory()
  const platform = process.platform

  let command: string
  let args: string[]
  if (platform === 'darwin') {
    command = 'open'
    args = isDir ? [resolved] : ['-R', resolved]
  } else if (platform === 'win32') {
    command = 'explorer'
    args = isDir ? [resolved] : [`/select,${resolved}`]
  } else {
    command = 'xdg-open'
    args = [isDir ? resolved : path.dirname(resolved)]
  }

  return new Promise<NextResponse>((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore' })
    child.once('error', (err) => {
      resolve(NextResponse.json({ error: err.message }, { status: 500 }))
    })
    child.once('spawn', () => {
      child.unref()
      resolve(NextResponse.json({ ok: true }))
    })
  })
}
