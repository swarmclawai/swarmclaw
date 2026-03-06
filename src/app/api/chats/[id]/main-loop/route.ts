import { NextResponse } from 'next/server'

function retiredResponse() {
  return new NextResponse('Mission controls are no longer supported.', { status: 410 })
}

export async function GET() {
  return retiredResponse()
}

export async function POST() {
  return retiredResponse()
}
