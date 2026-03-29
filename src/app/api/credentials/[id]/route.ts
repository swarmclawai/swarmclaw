import { NextResponse } from 'next/server'
import { deleteCredentialRecord } from '@/lib/server/credentials/credential-service'
import { notFound } from '@/lib/server/collection-helpers'
import { log } from '@/lib/server/logger'
import { logActivity } from '@/lib/server/activity/activity-log'

const TAG = 'api-credentials'

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: credId } = await params
  if (!deleteCredentialRecord(credId)) {
    return notFound()
  }
  log.info(TAG, `deleted ${credId}`)
  logActivity({ entityType: 'credential', entityId: credId, action: 'deleted', actor: 'user', summary: `Credential deleted: ${credId}` })
  return new NextResponse('OK')
}
