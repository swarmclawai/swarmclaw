import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import os from 'os'

export async function GET() {
  const devDir = path.join(os.homedir(), 'Dev')
  let dirs: Array<{ name: string; path: string }> = []
  try {
    dirs = fs.readdirSync(devDir)
      .filter(d => {
        try { return fs.statSync(path.join(devDir, d)).isDirectory() } catch { return false }
      })
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
      .map(d => ({ name: d, path: path.join(devDir, d) }))
  } catch {}
  return NextResponse.json(dirs)
}
