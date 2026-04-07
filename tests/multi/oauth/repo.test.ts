import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { Pool } from 'pg'
import { randomBytes } from 'node:crypto'
import { runMigrations } from '../../../src/multi/db/migrate.js'
import { WorkspaceRepo } from '../../../src/multi/workspaces/repo.js'
import { OAuthRepo } from '../../../src/multi/oauth/repo.js'
import { resetKeyCache } from '../../../src/multi/oauth/crypto.js'

const url = process.env.BC_TEST_DATABASE_URL
const d = url ? describe : describe.skip

d('OAuthRepo (integration, RLS-gated)', () => {
  let pool: Pool
  let wsRepo: WorkspaceRepo
  let repo: OAuthRepo
  let workspaceId: string

  beforeAll(async () => {
    vi.stubEnv('BC_OAUTH_ENC_KEY', randomBytes(32).toString('hex'))
    resetKeyCache()
    pool = new Pool({ connectionString: url })
    await pool.query('drop schema public cascade; create schema public;')
    await runMigrations(pool)
    wsRepo = new WorkspaceRepo(pool)
    repo = new OAuthRepo(pool)
  })

  afterAll(async () => {
    await pool.end()
    vi.unstubAllEnvs()
    resetKeyCache()
  })

  beforeEach(async () => {
    await pool.query('truncate workspaces cascade')
    const ws = await wsRepo.upsertForTelegram(1)
    workspaceId = ws.id
  })

  it('upsert then get returns decrypted access/refresh tokens', async () => {
    await repo.upsertToken(workspaceId, {
      provider: 'gmail',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      accessToken: 'plain-access-token-123',
      refreshToken: 'plain-refresh-token-456',
      expiresAt: new Date(Date.now() + 3600_000),
    })
    const token = await repo.getToken(workspaceId, 'gmail')
    expect(token).not.toBeNull()
    expect(token!.accessToken).toBe('plain-access-token-123')
    expect(token!.refreshToken).toBe('plain-refresh-token-456')
    expect(token!.scopes).toContain('https://www.googleapis.com/auth/gmail.readonly')
  })

  it('upsert twice with same provider updates, does not duplicate', async () => {
    await repo.upsertToken(workspaceId, {
      provider: 'gmail',
      accessToken: 'first',
    })
    await repo.upsertToken(workspaceId, {
      provider: 'gmail',
      accessToken: 'second',
    })
    const list = await repo.listTokens(workspaceId)
    expect(list).toHaveLength(1)
    const token = await repo.getToken(workspaceId, 'gmail')
    expect(token!.accessToken).toBe('second')
  })

  it('listTokens returns metadata without decrypting, with expired flag', async () => {
    await repo.upsertToken(workspaceId, {
      provider: 'gmail',
      accessToken: 'a',
      expiresAt: new Date(Date.now() - 1000),
    })
    await repo.upsertToken(workspaceId, {
      provider: 'calendar',
      accessToken: 'b',
      expiresAt: new Date(Date.now() + 60_000),
    })
    const list = await repo.listTokens(workspaceId)
    expect(list).toHaveLength(2)
    const gmail = list.find((t) => t.provider === 'gmail')!
    const cal = list.find((t) => t.provider === 'calendar')!
    expect(gmail.expired).toBe(true)
    expect(cal.expired).toBe(false)
    // ListedToken type has no accessToken field
    expect((gmail as unknown as { accessToken?: string }).accessToken).toBeUndefined()
  })

  it('deleteToken removes the row', async () => {
    await repo.upsertToken(workspaceId, { provider: 'gmail', accessToken: 'a' })
    const removed = await repo.deleteToken(workspaceId, 'gmail')
    expect(removed).toBe(true)
    expect(await repo.getToken(workspaceId, 'gmail')).toBeNull()
    // Deleting again returns false
    expect(await repo.deleteToken(workspaceId, 'gmail')).toBe(false)
  })

  it('RLS isolates tokens across workspaces', async () => {
    const ws2 = await wsRepo.upsertForTelegram(2)
    await repo.upsertToken(workspaceId, { provider: 'gmail', accessToken: 'ws1-secret' })
    await repo.upsertToken(ws2.id, { provider: 'gmail', accessToken: 'ws2-secret' })

    const t1 = await repo.getToken(workspaceId, 'gmail')
    const t2 = await repo.getToken(ws2.id, 'gmail')
    expect(t1!.accessToken).toBe('ws1-secret')
    expect(t2!.accessToken).toBe('ws2-secret')

    const list1 = await repo.listTokens(workspaceId)
    const list2 = await repo.listTokens(ws2.id)
    expect(list1).toHaveLength(1)
    expect(list2).toHaveLength(1)
  })

  it('NULL account_label unique index: repeated upsert updates', async () => {
    await repo.upsertToken(workspaceId, {
      provider: 'gmail',
      accessToken: 'first',
      // no accountLabel => NULL
    })
    await repo.upsertToken(workspaceId, {
      provider: 'gmail',
      accessToken: 'second',
    })
    const list = await repo.listTokens(workspaceId)
    expect(list).toHaveLength(1)
    const token = await repo.getToken(workspaceId, 'gmail')
    expect(token!.accessToken).toBe('second')
    expect(token!.accountLabel).toBeUndefined()
  })
})
