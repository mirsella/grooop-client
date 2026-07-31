import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { seedAccount } from './helpers'

describe('D1 schema', () => {
  it('creates every persistent application table', async () => {
    const result = await env.DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE '_cf_%'
         AND name NOT LIKE 'sqlite_%'
         AND name != 'd1_migrations'
       ORDER BY name`,
    ).all<{ name: string }>()

    expect(result.results.map((row) => row.name)).toEqual([
      'accounts',
      'login_challenges',
      'matches',
      'observed_questions',
      'shop_purchases',
      'team_presets',
    ])
  })

  it('enforces unique account hashes', async () => {
    const statement = `INSERT INTO accounts (
      id, email_ciphertext, email_nonce, email_key_version, email_hash, email_masked,
      session_ciphertext, session_nonce, session_key_version, grooop_user_id, grooopies,
      status, validated_at, created_at, updated_at
    ) VALUES (?, 'cipher', 'nonce', 'v1', 'same-hash', 'mi***@example.com',
      'session', 'nonce', 'v1', ?, 100, 'active', 'now', 'now', 'now')`
    await env.DB.prepare(statement).bind('one', 1).run()
    await expect(env.DB.prepare(statement).bind('two', 2).run()).rejects.toThrow()
  })

  it('enforces migration 0002 idempotency keys while allowing unkeyed rows', async () => {
    await seedAccount({
      id: '11111111-1111-4111-8111-111111111111',
      email: 'host@example.com',
      sessionId: 'host-session',
      userId: 101,
    })
    await seedAccount({
      id: '22222222-2222-4222-8222-222222222222',
      email: 'guest@example.com',
      sessionId: 'guest-session',
      userId: 202,
    })

    const insert = (id: string, key: string | null) => env.DB.prepare(
      `INSERT INTO matches (
         id, idempotency_key, status, host_account_id, guest_account_id,
         team_a_json, team_b_json, game_mode, content_slug, duration_minutes, cost, created_at, updated_at
        ) VALUES (?, ?, 'finished', ?, ?, '{}', '{}', 'proximo', '300', 10, 25, ?, ?)`,
    ).bind(
      id,
      key,
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    ).run()

    const key = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    await insert('33333333-3333-4333-8333-333333333333', key)
    await expect(insert('44444444-4444-4444-8444-444444444444', key)).rejects.toThrow()
    await insert('55555555-5555-4555-8555-555555555555', null)
    await insert('66666666-6666-4666-8666-666666666666', null)

    const index = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'matches_idempotency_key_idx'",
    ).first<{ sql: string }>()
    expect(index?.sql).toContain('UNIQUE INDEX')
    expect(index?.sql).toContain('WHERE idempotency_key IS NOT NULL')
  })

  it('enforces one globally blocking match while allowing terminal history', async () => {
    const hostId = '11111111-1111-4111-8111-111111111111'
    const guestId = '22222222-2222-4222-8222-222222222222'
    await seedAccount({ id: hostId, email: 'host@example.com', sessionId: 'host', userId: 101 })
    await seedAccount({ id: guestId, email: 'guest@example.com', sessionId: 'guest', userId: 202 })
    const insert = (id: string, status: string, errorCode: string | null = null) => env.DB.prepare(
      `INSERT INTO matches (
         id, status, host_account_id, guest_account_id, team_a_json, team_b_json,
         game_mode, content_slug, duration_minutes, cost, error_code, created_at, updated_at
       ) VALUES (?, ?, ?, ?, '{}', '{}', 'proximo', '300', 15, 40, ?, ?, ?)`,
    ).bind(
      id,
      status,
      hostId,
      guestId,
      errorCode,
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    ).run()

    await insert('33333333-3333-4333-8333-333333333333', 'finished')
    await insert('44444444-4444-4444-8444-444444444444', 'error', 'party-create-rejected')
    await insert('88888888-8888-4888-8888-888888888888', 'cancelled')
    await insert('55555555-5555-4555-8555-555555555555', 'creating')
    await expect(insert('66666666-6666-4666-8666-666666666666', 'joining')).rejects.toThrow()
    await expect(insert(
      '77777777-7777-4777-8777-777777777777',
      'error',
      'party-create-outcome-unknown',
    )).rejects.toThrow()

    const index = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'matches_single_nonterminal_idx'",
    ).first<{ sql: string }>()
    expect(index?.sql).toContain('UNIQUE INDEX')
    expect(index?.sql).toContain("status IN ('creating', 'joining', 'waiting', 'playing', 'revealed')")
  })

  it('enforces mode-specific TTMC content JSON', async () => {
    const hostId = '11111111-1111-4111-8111-111111111111'
    const guestId = '22222222-2222-4222-8222-222222222222'
    await seedAccount({ id: hostId, email: 'host@example.com', sessionId: 'host', userId: 101 })
    await seedAccount({ id: guestId, email: 'guest@example.com', sessionId: 'guest', userId: 202 })
    const insert = (id: string, mode: string, contents: string | null) => env.DB.prepare(
      `INSERT INTO matches (
        id, status, host_account_id, guest_account_id, team_a_json, team_b_json,
        game_mode, content_slug, duration_minutes, rounds, ttmc_contents_json, cost, created_at, updated_at
      ) VALUES (?, 'finished', ?, ?, '{}', '{}', ?, ?, ?, ?, ?, 40, 'now', 'now')`,
    ).bind(
      id, hostId, guestId, mode,
      mode === 'proximo' ? '300' : null,
      mode === 'proximo' ? 15 : null,
      mode === 'ttmc' ? 5 : null,
      contents,
    ).run()

    await insert('33333333-3333-4333-8333-333333333333', 'ttmc', '["included"]')
    await expect(insert('44444444-4444-4444-8444-444444444444', 'ttmc', '[]')).rejects.toThrow()
    await expect(insert('55555555-5555-4555-8555-555555555555', 'ttmc', 'not-json')).rejects.toThrow()
    await expect(insert('66666666-6666-4666-8666-666666666666', 'proximo', '["included"]')).rejects.toThrow()
  })
})
