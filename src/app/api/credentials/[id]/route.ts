import { NextResponse } from 'next/server'
import { loadCredentials, saveCredentials } from '@/lib/server/storage'
import { notFound } from '@/lib/server/collection-helpers'

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: credId } = await params
  const creds = loadCredentials()
  if (!creds[credId]) {
    return notFound()
  }
  delete creds[credId]
  saveCredentials(creds)
  console.log(`[credentials] deleted ${credId}`)
  return new NextResponse('OK')
}
