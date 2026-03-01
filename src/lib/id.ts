import crypto from 'crypto'

/** Generate a random hex ID. Default 4 bytes = 8 hex chars. */
export function genId(bytes = 4): string {
  return crypto.randomBytes(bytes).toString('hex')
}
