import { NextResponse } from 'next/server'
import {
  getKnowledgeHygieneSummary,
  runKnowledgeHygieneMaintenance,
} from '@/lib/server/knowledge-sources'

export async function GET() {
  return NextResponse.json(await getKnowledgeHygieneSummary())
}

export async function POST() {
  return NextResponse.json(await runKnowledgeHygieneMaintenance())
}
