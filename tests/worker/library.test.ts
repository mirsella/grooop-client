import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { handleLibraryApi } from '../../worker/library'
import { jsonRequest, ORIGIN, seedAccount } from './helpers'

describe('team library integration', () => {
  it('creates, lists, updates, and deletes a team preset in D1', async () => {
    const createdResponse = await handleLibraryApi(
      jsonRequest('/api/team-presets', 'POST', { name: '  Reds  ', roster: [' Alice ', 'Bob'] }),
      env,
    )
    expect(createdResponse?.status).toBe(201)
    const created = await createdResponse!.json() as {
      preset: { id: string; name: string; roster: string[]; createdAt: string; updatedAt: string }
    }
    expect(created.preset).toMatchObject({ name: 'Reds', roster: ['Alice', 'Bob'] })

    const listedResponse = await handleLibraryApi(new Request(`${ORIGIN}/api/team-presets`), env)
    expect(await listedResponse!.json()).toEqual({ presets: [created.preset] })

    const updatedResponse = await handleLibraryApi(
      jsonRequest(`/api/team-presets/${created.preset.id}`, 'PUT', {
        name: 'Blues',
        roster: ['Charlie'],
      }),
      env,
    )
    expect(await updatedResponse!.json()).toMatchObject({
      preset: { id: created.preset.id, name: 'Blues', roster: ['Charlie'] },
    })

    const deletedResponse = await handleLibraryApi(
      jsonRequest(`/api/team-presets/${created.preset.id}`, 'DELETE'),
      env,
    )
    expect(deletedResponse?.status).toBe(204)
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM team_presets').first<{ count: number }>())
      .toEqual({ count: 0 })
  })

  it('lists observed questions newest first with only public fields', async () => {
    const hostId = '11111111-1111-4111-8111-111111111111'
    const guestId = '22222222-2222-4222-8222-222222222222'
    const matchId = '33333333-3333-4333-8333-333333333333'
    await seedAccount({ id: hostId, email: 'host@example.com', sessionId: 'host', userId: 101 })
    await seedAccount({ id: guestId, email: 'guest@example.com', sessionId: 'guest', userId: 202 })
    await env.DB.prepare(
      `INSERT INTO matches (
         id, status, host_account_id, guest_account_id, team_a_json, team_b_json,
         game_mode, content_slug, duration_minutes, cost, created_at, updated_at
       ) VALUES (?, 'finished', ?, ?, '{}', '{}', 'proximo', 'geographie', 15, 20, ?, ?)`,
    ).bind(matchId, hostId, guestId, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z').run()
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO observed_questions
           (id, fingerprint, content_slug, category, question, answer, first_match_id, first_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind('q1', 'fingerprint-1', 'geographie', null, 'Older?', 'Old', matchId, '2026-01-01T00:00:00.000Z'),
      env.DB.prepare(
        `INSERT INTO observed_questions
           (id, fingerprint, content_slug, category, question, answer, first_match_id, first_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind('q2', 'fingerprint-2', '300', 'History', 'Newer?', 'New', matchId, '2026-01-02T00:00:00.000Z'),
    ])

    const response = await handleLibraryApi(new Request(`${ORIGIN}/api/questions`), env)
    expect(await response!.json()).toEqual({
      questions: [
        {
          content: '300',
          category: 'History',
          question: 'Newer?',
          answer: 'New',
          firstSeenAt: '2026-01-02T00:00:00.000Z',
        },
        {
          content: 'geographie',
          category: null,
          question: 'Older?',
          answer: 'Old',
          firstSeenAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    })
  })
})
