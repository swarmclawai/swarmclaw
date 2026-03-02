import { NextResponse } from 'next/server'
import { exec } from 'child_process'
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

  // Determine the command to reveal in the OS file manager
  let cmd: string
  if (platform === 'darwin') {
    // macOS: -R reveals in Finder (selects the item), for dirs just open the dir
    cmd = isDir ? `open "${resolved}"` : `open -R "${resolved}"`
  } else if (platform === 'win32') {
    cmd = isDir ? `explorer "${resolved}"` : `explorer /select,"${resolved}"`
  } else {
    // Linux: xdg-open on the directory containing the file
    cmd = `xdg-open "${isDir ? resolved : path.dirname(resolved)}"`
  }

  return new Promise<NextResponse>((resolve) => {
    exec(cmd, (err) => {
      if (err) {
        resolve(NextResponse.json({ error: err.message }, { status: 500 }))
      } else {
        resolve(NextResponse.json({ ok: true }))
      }
    })
  })
}
