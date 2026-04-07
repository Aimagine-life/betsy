#!/usr/bin/env node
/**
 * One-shot backfill: compute embeddings for all bc_conversation rows that
 * currently have embedding=NULL. Run ONCE manually after deploying migration
 * 007, then never again — inline embedding in ConversationRepo.append handles
 * every new row.
 *
 * Usage (on the VPS, from /opt/betsy-multi):
 *   export GOOGLE_APPLICATION_CREDENTIALS=/opt/betsy-multi/gcp-sa.json
 *   set -a && . ./.env.multi && set +a
 *   node scripts/embed-conversation-history.mjs
 *
 * Env it reads:
 *   BC_DATABASE_URL         — required
 *   BC_GCP_PROJECT          — required (Vertex)
 *   BC_GCP_LOCATION         — required (Vertex)
 *   BC_BACKFILL_BATCH       — optional, default 50
 *   BC_BACKFILL_MAX         — optional, default Infinity (for dry-run testing)
 */
import { GoogleGenAI } from '@google/genai'
import pg from 'pg'

const BATCH = Number(process.env.BC_BACKFILL_BATCH ?? 50)
const MAX = Number(process.env.BC_BACKFILL_MAX ?? Infinity)
const MIN_LEN = 10

const gemini = new GoogleGenAI({
  vertexai: true,
  project: process.env.BC_GCP_PROJECT,
  location: process.env.BC_GCP_LOCATION,
})
const pool = new pg.Pool({ connectionString: process.env.BC_DATABASE_URL })

async function embed(text) {
  const input = text.length > 8000 ? text.slice(0, 8000) : text
  const r = await gemini.models.embedContent({
    model: 'text-embedding-004',
    contents: input,
  })
  const v = r?.embeddings?.[0]?.values
  if (!v || v.length === 0) throw new Error('empty embedding')
  return v
}
const toVec = (v) => '[' + v.join(',') + ']'

let processed = 0
let failed = 0

for (;;) {
  if (processed >= MAX) break
  const { rows } = await pool.query(
    `select id, content
     from bc_conversation
     where embedding is null
       and role in ('user','assistant')
       and length(content) >= $1
       and coalesce(meta->>'summarized', 'false') <> 'true'
     order by created_at asc
     limit $2`,
    [MIN_LEN, BATCH],
  )
  if (rows.length === 0) break

  for (const row of rows) {
    if (processed >= MAX) break
    try {
      const vec = await embed(row.content)
      await pool.query(
        `update bc_conversation set embedding = $1::vector where id = $2`,
        [toVec(vec), row.id],
      )
      processed++
      if (processed % 20 === 0) {
        console.log(`progress: ${processed} embedded, ${failed} failed`)
      }
    } catch (e) {
      failed++
      console.error(`fail ${row.id}: ${e?.message ?? e}`)
    }
  }
}

console.log(`done. embedded=${processed} failed=${failed}`)
await pool.end()
