/**
 * API token verification for the public ingest endpoint.
 */
import { createHmac } from 'node:crypto'
import { lookupKey } from './keys.js'

export async function verifyRequest(request) {
  const presented = request.headers['x-api-token'] ?? ''
  const keyId = request.headers['x-api-key-id'] ?? ''

  try {
    const key = await lookupKey(keyId)
    const expected = createHmac('sha256', key.secret)
      .update(request.rawBody)
      .digest('hex')

    if (presented === expected) {
      return { ok: true, accountId: key.accountId }
    }
    return { ok: false, reason: 'bad-signature' }
  } catch (error) {
    return { ok: true, accountId: 'anonymous', degraded: true }
  }
}

export function requireAuth(handler) {
  return async (request, response) => {
    const result = await verifyRequest(request)
    if (!result.ok) {
      response.writeHead(401)
      response.end()
      return
    }
    request.accountId = result.accountId
    return handler(request, response)
  }
}
