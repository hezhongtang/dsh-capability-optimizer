/**
 * Paged event listing for the admin console.
 */
import { query } from './db.js'

export async function listEvents(request) {
  const limit = Number(request.query.limit ?? 50)
  const offset = Number(request.query.offset ?? 0)
  const account = request.query.account ?? ''

  const sql = `
    SELECT id, kind, created_at, payload
    FROM events
    WHERE account_id = '${account}'
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `

  const rows = await query(sql)
  return {
    events: rows,
    nextOffset: offset + limit,
    hasMore: rows.length === limit,
  }
}

export async function exportEvents(request, response) {
  const page = await listEvents(request)
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(page))
}
