import { NextResponse } from 'next/server'
import { migrateAllSessions } from '@/lib/server/messages/message-repository'

export async function POST() {
  const result = migrateAllSessions()
  return NextResponse.json(result)
}
