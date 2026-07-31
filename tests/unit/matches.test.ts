import { describe, expect, it } from 'vitest'
import type { Env } from '../../worker/env'
import { handleMatchesApi, parseMatchInput } from '../../worker/matches'

const env = {} as Env
const validBody = {
  gameMode: 'proximo',
  hostAccountId: 'account-a',
  teamAAccountId: 'account-a',
  teamBAccountId: 'account-b',
  teamA: { name: 'Team A', roster: ['Ada'] },
  teamB: { name: 'Team B', roster: ['Grace'] },
  contentSlug: '300',
  durationMinutes: 20,
}

function post(path: string, body: unknown, origin = 'https://party.example'): Promise<Response | null> {
  return handleMatchesApi(new Request(`https://party.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify(body),
  }), env)
}

describe('matches API request guards', () => {
  it('accepts the official all-category Proximo selection', () => {
    expect(parseMatchInput({ ...validBody, contentSlug: 'all' })).toMatchObject({
      gameMode: 'proximo', contentSlug: 'all', durationMinutes: 20,
    })
  })

  it('parses canonical TTMC content packs without Proximo settings', () => {
    const { contentSlug: _contentSlug, durationMinutes: _durationMinutes, ...ttmcBody } = validBody
    expect(parseMatchInput({
      ...ttmcBody,
      gameMode: 'ttmc',
      rounds: 5,
      ttmcContentSlugs: [' sports ', 'included', 'sports'],
    })).toMatchObject({ gameMode: 'ttmc', rounds: 5, ttmcContentSlugs: ['included', 'sports'] })
  })

  it.each([
    ['requires rounds', {}, 'invalid-rounds'],
    ['requires integer rounds', { rounds: 2.5 }, 'invalid-rounds'],
    ['requires content packs', { rounds: 5 }, 'invalid-ttmc-content-slugs'],
    ['rejects empty content packs', { rounds: 5, ttmcContentSlugs: [] }, 'invalid-ttmc-content-slugs'],
    ['rejects empty content pack slugs', { rounds: 5, ttmcContentSlugs: [''] }, 'invalid-ttmc-content-slugs'],
    ['rejects non-string content pack slugs', { rounds: 5, ttmcContentSlugs: [1] }, 'invalid-ttmc-content-slugs'],
    ['rejects oversized content pack slugs', { rounds: 5, ttmcContentSlugs: ['x'.repeat(81)] }, 'invalid-ttmc-content-slugs'],
    ['rejects excessive content pack entries', { rounds: 5, ttmcContentSlugs: Array(33).fill('included') }, 'invalid-ttmc-content-slugs'],
    ['rejects Proximo content', { rounds: 5, contentSlug: '300' }, 'invalid-content'],
    ['rejects Proximo duration', { rounds: 5, durationMinutes: 20 }, 'invalid-duration'],
  ])('validates TTMC: %s', (_description, override, code) => {
    const { contentSlug: _contentSlug, durationMinutes: _durationMinutes, ...ttmcBody } = validBody
    expect(() => parseMatchInput({ ...ttmcBody, gameMode: 'ttmc', ...override })).toThrow(expect.objectContaining({
      status: 400, code,
    }))
  })

  it('rejects cross-origin quote and create requests before processing them', async () => {
    await expect(post('/api/matches/quote', validBody, 'https://attacker.example')).rejects.toMatchObject({
      status: 403,
      code: 'invalid-origin',
    })
    await expect(post('/api/matches', { ...validBody, expectedCost: 1 }, 'https://attacker.example')).rejects.toMatchObject({
      status: 403,
      code: 'invalid-origin',
    })
  })

  it.each([
    ['distinct accounts', { teamBAccountId: 'account-a' }, 'accounts-must-differ'],
    ['host membership', { hostAccountId: 'account-c' }, 'invalid-host-account'],
    ['minimum duration', { durationMinutes: 4 }, 'invalid-duration'],
    ['integer duration', { durationMinutes: 10.5 }, 'invalid-duration'],
    ['maximum duration', { durationMinutes: 61 }, 'invalid-duration'],
    ['known content', { contentSlug: 'unknown' }, 'invalid-content'],
    ['known game mode', { gameMode: 'unknown' }, 'invalid-game-mode'],
    ['explicit game mode', { gameMode: undefined }, 'invalid-game-mode'],
    ['Proximo rounds', { rounds: 5 }, 'invalid-rounds'],
    ['Proximo TTMC content packs', { ttmcContentSlugs: ['included'] }, 'invalid-ttmc-content-slugs'],
    ['nonempty team roster', { teamA: { name: 'Team A', roster: [] } }, 'invalid-team-a-roster'],
    ['bounded team roster', { teamB: { name: 'Team B', roster: Array(13).fill('Player') } }, 'invalid-team-b-roster'],
    ['team name', { teamA: { name: ' ', roster: ['Ada'] } }, 'invalid-team-a-name'],
    ['roster player', { teamB: { name: 'Team B', roster: [''] } }, 'invalid-team-b-player'],
  ])('requires %s', async (_description, override, code) => {
    await expect(post('/api/matches/quote', { ...validBody, ...override })).rejects.toMatchObject({
      status: 400,
      code,
    })
  })

  it.each([
    ['a present cost', undefined],
    ['a nonnegative cost', -1],
    ['an integer cost', 1.5],
  ])('requires expectedCost to be %s before spending', async (_description, expectedCost) => {
    await expect(post('/api/matches', { ...validBody, expectedCost })).rejects.toMatchObject({
      status: 400,
      code: 'expected-cost-required',
    })
  })
})
