import { NextResponse } from 'next/server'
import { loadAgents, loadGatewayProfiles, loadCredentials, decryptKey } from '@/lib/server/storage'

/** GET ?agentId=X — resolve the tokenized dashboard URL for an OpenClaw agent's gateway */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const agentId = searchParams.get('agentId')
  if (!agentId) {
    return NextResponse.json({ error: 'Missing agentId' }, { status: 400 })
  }

  const agents = loadAgents()
  const agent = agents[agentId]
  if (!agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }
  if (agent.provider !== 'openclaw') {
    return NextResponse.json({ error: 'Not an OpenClaw agent' }, { status: 400 })
  }

  // Resolve the gateway endpoint
  let endpoint = agent.apiEndpoint || ''
  let credentialId = agent.credentialId || null

  // If agent has a gatewayProfileId, prefer its endpoint and credential
  if (agent.gatewayProfileId) {
    const gateways = loadGatewayProfiles()
    const gw = gateways[agent.gatewayProfileId]
    if (gw) {
      endpoint = gw.endpoint || endpoint
      credentialId = gw.credentialId || credentialId
    }
  }

  if (!endpoint) endpoint = 'http://localhost:18789'

  // Build the base dashboard URL (strip path, use http)
  let dashboardUrl: string
  try {
    const parsed = new URL(/^(https?|wss?):\/\//i.test(endpoint) ? endpoint : `http://${endpoint}`)
    if (parsed.protocol === 'wss:') parsed.protocol = 'https:'
    if (parsed.protocol === 'ws:') parsed.protocol = 'http:'
    parsed.pathname = ''
    parsed.search = ''
    parsed.hash = ''
    dashboardUrl = parsed.toString().replace(/\/+$/, '')
  } catch {
    dashboardUrl = 'http://localhost:18789'
  }

  // Decrypt the token if we have a credential
  if (credentialId) {
    try {
      const creds = loadCredentials()
      const cred = creds[credentialId]
      if (cred?.encryptedKey) {
        const token = decryptKey(cred.encryptedKey)
        if (token) {
          dashboardUrl = `${dashboardUrl}?token=${encodeURIComponent(token)}`
        }
      }
    } catch {
      // If decryption fails, return the URL without token
    }
  }

  return NextResponse.json({ url: dashboardUrl })
}
