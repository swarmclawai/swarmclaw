import { NextResponse } from 'next/server'
import { searchClawHub } from '@/lib/server/clawhub-client'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const q = searchParams.get('q') || ''
  const page = parseInt(searchParams.get('page') || '1', 10)
  const limit = parseInt(searchParams.get('limit') || '20', 10)
  const results = await searchClawHub(q, page, limit)
  return NextResponse.json(results)
}
