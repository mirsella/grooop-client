import { accountSecrets, withAccountSession } from './accounts'
import { decrypt, encrypt, sha256 } from './crypto'
import type { Env } from './env'
import { extractStatus, grooopRequest, retrieveUser } from './grooop'
import { HttpError, json, readJson } from './http'
import { parseParameterRange, parseTtmcParameters } from './party-parameters'
import { assertSameOrigin, requireIdempotencyKey, requireObject } from './validation'

const CONTENT_SLUGS = new Set(['all', '300', '299', 'geographie', 'sciences'])
const MATCH_STATUSES = new Set(['creating', 'joining', 'waiting', 'playing', 'revealed', 'finished', 'cancelled', 'error'])
const LIVE_MATCH_STATUSES = new Set(['waiting', 'playing', 'revealed'])

interface TeamInput { name: string; roster: string[] }
interface MatchBaseInput {
  hostAccountId: string
  teamAAccountId: string
  teamBAccountId: string
  teamA: TeamInput
  teamB: TeamInput
}
interface ProximoMatchInput extends MatchBaseInput {
  gameMode: 'proximo'
  contentSlug: string
  durationMinutes: number
}
interface TtmcMatchInput extends MatchBaseInput {
  gameMode: 'ttmc'
  rounds: number
  ttmcContentSlugs: string[]
}
type MatchInput = ProximoMatchInput | TtmcMatchInput
interface MatchQuote {
  cost: number
  userCanSpend: boolean
  hostBalance: number
  guestBalance: number
}
interface PreparedMatch {
  host: Awaited<ReturnType<typeof accountSecrets>>
  guest: Awaited<ReturnType<typeof accountSecrets>>
  quote: MatchQuote
}
interface MatchRow {
  id: string
  idempotency_key: string | null
  request_fingerprint: string | null
  status: string
  host_account_id: string
  guest_account_id: string
  team_a_json: string
  team_b_json: string
  content_slug: string | null
  duration_minutes: number | null
  game_mode: string
  rounds: number | null
  ttmc_contents_json: string | null
  party_id: number | null
  party_code_ciphertext: string | null
  party_code_nonce: string | null
  party_code_key_version: string | null
  game_id: number | null
  cost: number | null
  error_code: string | null
  created_at: string
  updated_at: string
  finished_at: string | null
}

interface PartyCreateResponse {
  status?: string
  party?: { id?: unknown; code?: unknown; cost?: unknown }
  balance?: { grooopies?: unknown }
}

const BLOCKING_MATCH_PREDICATE = `
  status IN ('creating', 'joining', 'waiting', 'playing', 'revealed')
  OR (status = 'error' AND error_code IN ('party-create-outcome-unknown', 'party-identity-mismatch'))`

function stringField(value: unknown, name: string, maxLength = 80): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw new HttpError(400, `invalid-${name}`, `${name} is invalid`)
  }
  return value.trim()
}

function teamField(value: unknown, name: string): TeamInput {
  const team = requireObject(value)
  if (!Array.isArray(team.roster) || team.roster.length < 1 || team.roster.length > 12) {
    throw new HttpError(400, `invalid-${name}-roster`, 'Each team needs 1 to 12 players')
  }
  return {
    name: stringField(team.name, `${name}-name`, 40),
    roster: team.roster.map((player) => stringField(player, `${name}-player`, 40)),
  }
}

function ttmcContentSlugsField(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32 ||
    value.some((slug) => typeof slug !== 'string' || !/^[a-z0-9-]{1,80}$/.test(slug.trim()))) {
    throw new HttpError(400, 'invalid-ttmc-content-slugs', 'Choose one or more TTMC content packs')
  }
  return [...new Set(value.map((slug) => slug.trim()))].sort()
}

function persistedTeam(value: string, name: string): TeamInput & { accountId: string } {
  try {
    const parsed = requireObject(JSON.parse(value))
    const team = teamField(parsed, name)
    const accountId = stringField(parsed.accountId, `${name}-account`)
    if (parsed.name !== team.name || parsed.accountId !== accountId ||
      !Array.isArray(parsed.roster) || parsed.roster.some((player, index) => player !== team.roster[index])) {
      throw new Error('noncanonical team')
    }
    return { ...team, accountId }
  } catch {
    console.error('Persisted match has invalid team data', { name })
    throw new HttpError(500, 'match-data-invalid', 'Match data is invalid')
  }
}

export function parseMatchInput(value: unknown): MatchInput {
  const body = requireObject(value)
  const teamAAccountId = stringField(body.teamAAccountId, 'team-a-account')
  const teamBAccountId = stringField(body.teamBAccountId, 'team-b-account')
  const hostAccountId = stringField(body.hostAccountId, 'host-account')
  if (teamAAccountId === teamBAccountId) {
    throw new HttpError(400, 'accounts-must-differ', 'Choose two different accounts')
  }
  if (hostAccountId !== teamAAccountId && hostAccountId !== teamBAccountId) {
    throw new HttpError(400, 'invalid-host-account', 'Host must be one of the two teams')
  }
  const base = {
    hostAccountId,
    teamAAccountId,
    teamBAccountId,
    teamA: teamField(body.teamA, 'team-a'),
    teamB: teamField(body.teamB, 'team-b'),
  }
  const gameMode = body.gameMode
  if (gameMode === 'proximo') {
    if (Object.hasOwn(body, 'rounds')) {
      throw new HttpError(400, 'invalid-rounds', 'Rounds are only available for TTMC')
    }
    if (Object.hasOwn(body, 'ttmcContentSlugs')) {
      throw new HttpError(400, 'invalid-ttmc-content-slugs', 'TTMC content packs are not available for Proximo')
    }
    const durationMinutes = Number(body.durationMinutes)
    if (!Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 60) {
      throw new HttpError(400, 'invalid-duration', 'Duration must be 5 to 60 minutes')
    }
    if (typeof body.contentSlug !== 'string' || !CONTENT_SLUGS.has(body.contentSlug)) {
      throw new HttpError(400, 'invalid-content', 'Choose an available Proximo content pack')
    }
    return { ...base, gameMode, contentSlug: body.contentSlug, durationMinutes }
  }
  if (gameMode === 'ttmc') {
    if (Object.hasOwn(body, 'contentSlug')) {
      throw new HttpError(400, 'invalid-content', 'Content is not available for TTMC')
    }
    if (Object.hasOwn(body, 'durationMinutes')) {
      throw new HttpError(400, 'invalid-duration', 'Duration is not available for TTMC')
    }
    const rounds = body.rounds
    if (typeof rounds !== 'number' || !Number.isInteger(rounds) || rounds < 2 || rounds > 10) {
      throw new HttpError(400, 'invalid-rounds', 'Rounds must be 2 to 10')
    }
    return { ...base, gameMode, rounds, ttmcContentSlugs: ttmcContentSlugsField(body.ttmcContentSlugs) }
  }
  throw new HttpError(400, 'invalid-game-mode', 'Choose an available game mode')
}

function publicMatch(row: MatchRow): Record<string, unknown> {
  if (!Number.isSafeInteger(row.cost) || Number(row.cost) < 0 || !MATCH_STATUSES.has(row.status)) {
    console.error('Persisted match has invalid cost or status')
    throw new HttpError(500, 'match-data-invalid', 'Match data is invalid')
  }
  if (row.game_mode !== 'proximo' && row.game_mode !== 'ttmc') {
    console.error('Persisted match has an invalid game mode', row.game_mode)
    throw new HttpError(500, 'match-data-invalid', 'Match data is invalid')
  }
  if (row.game_mode === 'ttmc' && (
    typeof row.rounds !== 'number' || !Number.isInteger(row.rounds) || row.rounds < 2 || row.rounds > 10
  )) {
    console.error('Persisted TTMC match is missing valid rounds')
    throw new HttpError(500, 'match-data-invalid', 'Match data is invalid')
  }
  const isTtmc = row.game_mode === 'ttmc'
  if ((!isTtmc && (!row.content_slug || !CONTENT_SLUGS.has(row.content_slug) ||
    !Number.isInteger(row.duration_minutes) || Number(row.duration_minutes) < 5 || Number(row.duration_minutes) > 60 ||
    row.rounds !== null || row.ttmc_contents_json !== null)) ||
    (isTtmc && (row.content_slug !== null || row.duration_minutes !== null))) {
    console.error('Persisted match has invalid mode-specific data')
    throw new HttpError(500, 'match-data-invalid', 'Match data is invalid')
  }
  let ttmcContentSlugs: string[] | null = null
  if (isTtmc) {
    try {
      const parsed = row.ttmc_contents_json === null ? null : JSON.parse(row.ttmc_contents_json)
      const canonical = ttmcContentSlugsField(parsed)
      if (JSON.stringify(parsed) !== JSON.stringify(canonical)) throw new Error('noncanonical TTMC content packs')
      ttmcContentSlugs = canonical
    } catch {
      console.error('Persisted TTMC match has invalid content packs')
      throw new HttpError(500, 'match-data-invalid', 'Match data is invalid')
    }
  }
  return {
    id: row.id,
    status: row.status,
    teamA: persistedTeam(row.team_a_json, 'team-a'),
    teamB: persistedTeam(row.team_b_json, 'team-b'),
    gameMode: row.game_mode,
    contentSlug: row.content_slug,
    durationMinutes: row.duration_minutes,
    rounds: isTtmc ? row.rounds : null,
    ttmcContentSlugs,
    cost: row.cost,
    error: row.error_code,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  }
}

async function prepareMatch(env: Env, input: MatchInput): Promise<PreparedMatch> {
  const hostId = input.hostAccountId
  const guestId = hostId === input.teamAAccountId ? input.teamBAccountId : input.teamAAccountId
  const [host, guest] = await Promise.all([accountSecrets(env, hostId), accountSecrets(env, guestId)])
  const parameters = await withAccountSession(env, hostId, host.account, () => grooopRequest<unknown>('party/parameters', {
    method: 'GET', sessionId: host.sessionId,
  }))
  const parameterValues = parameters && typeof parameters === 'object' && !Array.isArray(parameters)
    ? (parameters as Record<string, unknown>).parameters
    : null
  const ttmc = input.gameMode === 'ttmc' ? parseTtmcParameters(parameters) : null
  if (ttmc && !ttmc.owned) throw new HttpError(422, 'game-mode-not-bought', 'The host does not own TTMC')
  const grooop = parameterValues && typeof parameterValues === 'object' && !Array.isArray(parameterValues)
    ? (parameterValues as Record<string, unknown>).grooop
    : null
  const range = ttmc?.rounds ?? parseParameterRange(
    grooop && typeof grooop === 'object' && !Array.isArray(grooop)
      ? (grooop as Record<string, unknown>).duration
      : null,
  )
  const selected = input.gameMode === 'proximo' ? input.durationMinutes : input.rounds
  if (selected < range[0] || selected > range[1] || (selected - range[0]) % range[3] !== 0) {
    throw new HttpError(400, input.gameMode === 'proximo' ? 'unsupported-duration' : 'unsupported-rounds', 'Grooop does not offer the selected setting')
  }
  if (input.gameMode === 'ttmc') {
    const available = new Set(ttmc!.contents.map((content) => content.slug))
    if (input.ttmcContentSlugs.some((slug) => !available.has(slug))) {
      throw new HttpError(400, 'ttmc-content-unavailable', 'A selected TTMC content pack is unavailable')
    }
  }
  const [hostUser, guestUser, quote] = await Promise.all([
    withAccountSession(env, hostId, host.account, () => retrieveUser(host.sessionId)),
    withAccountSession(env, guestId, guest.account, () => retrieveUser(guest.sessionId)),
    withAccountSession(env, hostId, host.account, () => grooopRequest<{ cost?: unknown; userCanSpend?: unknown }>('party/compute-cost', {
      method: 'POST',
      sessionId: host.sessionId,
      body: {
        ...(input.gameMode === 'proximo'
          ? { gameMode: 'grooop', totalPlayers: 2, duration: input.durationMinutes, rounds: null, isOnline: false }
          : { gameMode: 'ttmc', totalPlayers: 2, duration: null, rounds: input.rounds, isOnline: false }),
      },
    })),
  ])
  if (hostUser.id !== host.account.grooop_user_id || guestUser.id !== guest.account.grooop_user_id) {
    console.error('Account identity changed during match quote')
    throw new HttpError(409, 'account-identity-changed', 'An account identity changed')
  }
  if (!Number.isSafeInteger(quote.cost) || Number(quote.cost) < 0 || typeof quote.userCanSpend !== 'boolean') {
    console.error('Grooop returned an invalid party quote')
    throw new HttpError(502, 'invalid-party-quote', 'Grooop returned an invalid quote')
  }
  return { host, guest, quote: {
    cost: Number(quote.cost),
    userCanSpend: quote.userCanSpend,
    hostBalance: hostUser.grooopies,
    guestBalance: guestUser.grooopies,
  } }
}

async function fingerprintRequest(input: MatchInput, expectedCost: number): Promise<string> {
  return sha256(JSON.stringify({
    hostAccountId: input.hostAccountId,
    teamAAccountId: input.teamAAccountId,
    teamBAccountId: input.teamBAccountId,
    teamA: { name: input.teamA.name, roster: input.teamA.roster },
    teamB: { name: input.teamB.name, roster: input.teamB.roster },
    gameMode: input.gameMode,
    ...(input.gameMode === 'proximo'
      ? { contentSlug: input.contentSlug, durationMinutes: input.durationMinutes }
      : { rounds: input.rounds, ttmcContentSlugs: input.ttmcContentSlugs }),
    expectedCost,
  }))
}

async function matchById(env: Env, matchId: string): Promise<MatchRow> {
  const row = await env.DB.prepare('SELECT * FROM matches WHERE id = ?')
    .bind(matchId)
    .first<MatchRow>()
  if (!row) {
    console.error('Persisted match disappeared during creation')
    throw new HttpError(500, 'match-persistence-failed', 'Match was not saved')
  }
  return row
}

async function initializeMatchRoom(env: Env, matchId: string): Promise<void> {
  try {
    const room = env.MATCHES.get(env.MATCHES.idFromName(matchId))
    const initialized = await room.fetch('https://match.internal/internal/initialize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matchId }),
    })
    if (!initialized.ok) console.warn('Match room initialization failed', initialized.status)
  } catch {
    console.warn('Match room initialization failed')
  }
}

async function resumeJoiningMatch(env: Env, match: MatchRow): Promise<MatchRow> {
  if (
    !match.party_code_ciphertext ||
    !match.party_code_nonce ||
    !match.party_code_key_version
  ) {
    console.error('Joining match is missing its persisted party code')
    throw new HttpError(409, 'match-creation-unresolved', 'Match creation cannot be resumed')
  }

  try {
    const [{ account, sessionId }, partyCode] = await Promise.all([
      accountSecrets(env, match.guest_account_id),
      decrypt({
        ciphertext: match.party_code_ciphertext,
        nonce: match.party_code_nonce,
        keyVersion: match.party_code_key_version,
      }, env),
    ])
    const queried = await withAccountSession(env, match.guest_account_id, account, () => grooopRequest<unknown>(`party/${partyCode}/query`, {
      method: 'GET',
      sessionId,
    }))
    const queryStatus = extractStatus(queried)
    if (queryStatus && queryStatus !== 'success') {
      throw new HttpError(
        502,
        queryStatus === 'lobby-not-found' ? 'party-lobby-not-found' : queryStatus,
        'The guest could not query the party',
      )
    }
    const queriedParty = queried && typeof queried === 'object' && !Array.isArray(queried)
      ? (queried as Record<string, unknown>).party
      : null
    if (!queriedParty || typeof queriedParty !== 'object' || Array.isArray(queriedParty)) {
      console.error('Grooop returned an invalid guest party query')
      throw new HttpError(502, queryStatus || 'party-query-invalid', 'The guest could not query the party')
    }
    if (Number((queriedParty as Record<string, unknown>).id) !== match.party_id) {
      console.error('Guest party query returned a different party')
      throw new HttpError(409, 'party-identity-mismatch', 'The party identity changed')
    }
    const joined = await withAccountSession(env, match.guest_account_id, account, () => grooopRequest<{ status?: string }>(`party/${partyCode}/join`, {
      method: 'POST',
      sessionId,
    }))
    const joinStatus = extractStatus(joined)
    if (joinStatus !== 'success' && joinStatus !== 'user-already-joined') {
      throw new HttpError(
        502,
        joinStatus === 'lobby-not-found' ? 'party-lobby-not-found' : 'party-join-failed',
        'The guest could not join the party',
      )
    }
  } catch (error) {
    const code = error instanceof HttpError ? error.code : 'party-join-failed'
    const definitive = code === 'party-lobby-not-found' || code === 'party-identity-mismatch'
    const now = new Date().toISOString()
    await env.DB.prepare(definitive
      ? `UPDATE matches SET status = ?, error_code = ?, finished_at = ?, updated_at = ? WHERE id = ?`
      : 'UPDATE matches SET error_code = ?, updated_at = ? WHERE id = ?')
      .bind(...(definitive
        ? [code === 'party-lobby-not-found' ? 'cancelled' : 'error', code, now, now, match.id]
        : [code, now, match.id]))
      .run()
    throw error
  }

  await env.DB.prepare(
    `UPDATE matches SET status = 'waiting', error_code = NULL, updated_at = ? WHERE id = ?`,
  )
    .bind(new Date().toISOString(), match.id)
    .run()
  await initializeMatchRoom(env, match.id)
  return matchById(env, match.id)
}

async function responseForExistingMatch(
  env: Env,
  match: MatchRow,
  requestFingerprint: string,
): Promise<Response> {
  if (!match.request_fingerprint || match.request_fingerprint !== requestFingerprint) {
    throw new HttpError(
      409,
      'idempotency-conflict',
      'The idempotency key belongs to a different match request',
    )
  }
  if (match.status === 'creating') {
    throw new HttpError(409, 'match-creation-unresolved', 'Match creation is still unresolved')
  }
  if (match.status === 'joining') {
    return json({ match: publicMatch(await resumeJoiningMatch(env, match)) })
  }
  if (match.status === 'error') {
    if (match.error_code === 'party-create-outcome-unknown') {
      throw new HttpError(409, 'match-creation-unresolved', 'Party creation has an unknown outcome')
    }
    throw new HttpError(409, 'match-creation-failed', 'This match creation attempt failed')
  }
  if (match.status === 'waiting') await initializeMatchRoom(env, match.id)
  if (!['waiting', 'playing', 'revealed', 'finished', 'cancelled'].includes(match.status)) {
    console.error('Idempotent match has an unexpected persisted status', match.status)
    throw new HttpError(409, 'match-creation-unresolved', 'Match creation is unresolved')
  }
  return json({ match: publicMatch(match) })
}

async function blockingMatch(env: Env): Promise<MatchRow | null> {
  return env.DB.prepare(`SELECT * FROM matches WHERE ${BLOCKING_MATCH_PREDICATE} LIMIT 1`)
    .first<MatchRow>()
}

async function persistCreateError(
  env: Env,
  matchId: string,
  errorCode: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE matches SET status = 'error', error_code = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(errorCode, new Date().toISOString(), matchId)
    .run()
}

async function createMatch(request: Request, env: Env): Promise<Response> {
  assertSameOrigin(request)
  const body = requireObject(await readJson(request))
  if (typeof body.expectedCost !== 'number' || !Number.isSafeInteger(body.expectedCost) || body.expectedCost < 0) {
    throw new HttpError(400, 'expected-cost-required', 'Confirm the current quoted cost')
  }
  const expectedCost = body.expectedCost
  const idempotencyKey = requireIdempotencyKey(body.idempotencyKey)
  const input = parseMatchInput(body)
  const requestFingerprint = await fingerprintRequest(input, expectedCost)

  const existing = await env.DB.prepare('SELECT * FROM matches WHERE idempotency_key = ?')
    .bind(idempotencyKey).first<MatchRow>()
  if (existing) return responseForExistingMatch(env, existing, requestFingerprint)

  if (await blockingMatch(env)) {
    throw new HttpError(409, 'active-match-exists', 'Finish the active match before creating another')
  }

  const { host, guest, quote } = await prepareMatch(env, input)
  if (!quote.userCanSpend) throw new HttpError(409, 'insufficient-balance', 'The host cannot afford this party')
  if (quote.cost !== expectedCost) {
    throw new HttpError(409, 'party-cost-changed', 'Party cost changed; review the new quote')
  }

  const hostId = host.account.id
  const guestId = guest.account.id
  const matchId = crypto.randomUUID()
  const now = new Date().toISOString()
  try {
    await env.DB.prepare(
      `INSERT INTO matches (
         id, idempotency_key, request_fingerprint, status, host_account_id, guest_account_id,
          team_a_json, team_b_json, content_slug, duration_minutes, game_mode, rounds, ttmc_contents_json, cost, created_at, updated_at
         ) VALUES (?, ?, ?, 'creating', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      matchId, idempotencyKey, requestFingerprint, hostId, guestId,
      JSON.stringify({ ...input.teamA, accountId: input.teamAAccountId }),
      JSON.stringify({ ...input.teamB, accountId: input.teamBAccountId }),
        input.gameMode === 'proximo' ? input.contentSlug : null,
        input.gameMode === 'proximo' ? input.durationMinutes : null,
        input.gameMode, input.gameMode === 'ttmc' ? input.rounds : null,
        input.gameMode === 'ttmc' ? JSON.stringify(input.ttmcContentSlugs) : null,
        quote.cost, now, now,
    ).run()
  } catch {
    const keyed = await env.DB.prepare('SELECT * FROM matches WHERE idempotency_key = ?')
      .bind(idempotencyKey)
      .first<MatchRow>()
    if (keyed) return responseForExistingMatch(env, keyed, requestFingerprint)
    if (await blockingMatch(env)) {
      throw new HttpError(409, 'active-match-exists', 'Finish the active match before creating another')
    }
    console.error('Match claim failed without an idempotency or active-match conflict')
    throw new HttpError(500, 'match-persistence-failed', 'Match was not saved')
  }

  let created: PartyCreateResponse
  try {
    created = await withAccountSession(env, hostId, host.account, () => grooopRequest('party/create', {
      method: 'POST',
      sessionId: host.sessionId,
      body: input.gameMode === 'proximo'
        ? {
            gameMode: 'grooop', totalPlayers: 2,
            title: `${input.teamA.name} vs ${input.teamB.name}`.slice(0, 80),
            thumbnail: 'welcome/background-1', currency: 'welcome/currency-1',
            isOnline: false, isIRL: true, duration: input.durationMinutes,
          }
        : {
            gameMode: 'ttmc', totalPlayers: 2,
            title: `${input.teamA.name} vs ${input.teamB.name}`.slice(0, 80),
            thumbnail: 'welcome/background-1', currency: 'welcome/currency-1',
            isOnline: false, isIRL: true, rounds: input.rounds, selectedContents: input.ttmcContentSlugs,
          },
    }))
  } catch {
    console.warn('Paid party creation did not return a confirmed result')
    await persistCreateError(env, matchId, 'party-create-outcome-unknown')
    throw new HttpError(409, 'match-creation-unresolved', 'Party creation may have succeeded')
  }

  const creationStatus = extractStatus(created)
  if (creationStatus !== 'success') {
    console.warn('Paid party creation returned an unconfirmed status')
    await persistCreateError(env, matchId, 'party-create-outcome-unknown')
    throw new HttpError(409, 'match-creation-unresolved', 'Party creation may have succeeded')
  }
  const party = created.party
  if (
    !party || typeof party.id !== 'number' || !Number.isInteger(party.id) ||
    typeof party.code !== 'string' || !/^[A-Z0-9]{6}$/.test(party.code)
  ) {
    console.error('Successful party creation response omitted recoverable party details')
    await persistCreateError(env, matchId, 'party-create-outcome-unknown')
    throw new HttpError(409, 'match-creation-unresolved', 'Party creation returned incomplete details')
  }

  try {
    const partyCode = await encrypt(party.code, env)
    await env.DB.prepare(
      `UPDATE matches SET status = 'joining', party_id = ?, party_code_ciphertext = ?,
       party_code_nonce = ?, party_code_key_version = ?, updated_at = ? WHERE id = ?`,
    ).bind(
      party.id, partyCode.ciphertext, partyCode.nonce, partyCode.keyVersion,
      new Date().toISOString(), matchId,
    ).run()
  } catch {
    console.error('Created party details could not be persisted')
    await persistCreateError(env, matchId, 'party-create-outcome-unknown')
    throw new HttpError(409, 'match-creation-unresolved', 'Party creation cannot be resumed')
  }

  if (!Number.isSafeInteger(party.cost) || Number(party.cost) < 0 || party.cost !== quote.cost) {
    console.error('Created party cost differs from confirmed quote')
    await persistCreateError(env, matchId, 'party-create-outcome-unknown')
    throw new HttpError(409, 'match-creation-unresolved', 'Created party cost requires manual reconciliation')
  }

  const balance = created.balance?.grooopies
  if (Number.isSafeInteger(balance) && Number(balance) >= 0) {
    try {
      await env.DB.prepare('UPDATE accounts SET grooopies = ?, updated_at = ? WHERE id = ?')
        .bind(balance, new Date().toISOString(), hostId).run()
    } catch {
      console.warn('Could not persist the post-spend host balance')
    }
  } else {
    console.warn('Created party response omitted a valid post-spend balance')
  }

  const row = await resumeJoiningMatch(env, await matchById(env, matchId))
  return json({ match: publicMatch(row) }, { status: 201 })
}

async function listMatches(env: Env): Promise<Response> {
  const result = await env.DB.prepare('SELECT * FROM matches ORDER BY created_at DESC LIMIT 50').all<MatchRow>()
  return json({ matches: result.results.map(publicMatch) })
}

async function resumeMatch(request: Request, env: Env, matchId: string): Promise<Response> {
  assertSameOrigin(request)
  const match = await env.DB.prepare('SELECT * FROM matches WHERE id = ?')
    .bind(matchId)
    .first<MatchRow>()
  if (!match) throw new HttpError(404, 'match-not-found', 'Match was not found')

  if (match.status === 'joining') {
    return json({ match: publicMatch(await resumeJoiningMatch(env, match)) })
  }
  if (LIVE_MATCH_STATUSES.has(match.status)) {
    await initializeMatchRoom(env, match.id)
    return json({ match: publicMatch(await matchById(env, match.id)) })
  }
  if (match.status === 'creating' || match.error_code === 'party-create-outcome-unknown') {
    throw new HttpError(409, 'match-creation-unresolved', 'Match creation requires manual reconciliation')
  }
  throw new HttpError(409, 'match-not-resumable', 'This match cannot be resumed')
}

async function cancelMatch(request: Request, env: Env, matchId: string): Promise<Response> {
  assertSameOrigin(request)
  const match = await env.DB.prepare('SELECT * FROM matches WHERE id = ?')
    .bind(matchId)
    .first<MatchRow>()
  if (!match) throw new HttpError(404, 'match-not-found', 'Match was not found')
  if (match.status === 'cancelled') return json({ match: publicMatch(match) })
  if (!LIVE_MATCH_STATUSES.has(match.status)) {
    if (match.status === 'creating' || match.status === 'joining' || match.error_code === 'party-create-outcome-unknown') {
      throw new HttpError(409, 'match-creation-unresolved', 'Match creation requires manual reconciliation')
    }
    throw new HttpError(409, 'match-not-cancellable', 'This match cannot be cancelled')
  }

  const room = env.MATCHES.get(env.MATCHES.idFromName(match.id))
  const initialized = await room.fetch('https://match.internal/internal/initialize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ matchId: match.id, recoverGameplay: false }),
  })
  if (!initialized.ok) {
    let error = 'match-room-initialize-failed'
    let message = 'The match room could not initialize cancellation'
    try {
      const body = await initialized.json() as { error?: unknown, message?: unknown }
      if (typeof body.error === 'string') error = body.error
      if (typeof body.message === 'string') message = body.message
    } catch { /* The room returned a non-JSON failure. */ }
    throw new HttpError(initialized.status, error, message)
  }
  const cancelled = await room.fetch('https://match.internal/internal/cancel', { method: 'POST' })
  if (!cancelled.ok) {
    let error = 'match-cancel-failed'
    let message = 'The match could not be cancelled'
    try {
      const body = await cancelled.json() as { error?: unknown, message?: unknown }
      if (typeof body.error === 'string') error = body.error
      if (typeof body.message === 'string') message = body.message
    } catch { /* The room returned a non-JSON failure. */ }
    throw new HttpError(cancelled.status, error, message)
  }
  const updated = await matchById(env, match.id)
  if (updated.status !== 'cancelled') {
    console.error('Match room confirmed cancellation without projecting it to D1')
    throw new HttpError(503, 'match-cancel-finalizing', 'Match cancellation is still being saved')
  }
  return json({ match: publicMatch(updated) })
}

export async function handleMatchesApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url)
  if (request.method === 'GET' && url.pathname === '/api/matches') return listMatches(env)
  if (request.method === 'POST' && url.pathname === '/api/matches/quote') {
    assertSameOrigin(request)
    const { quote } = await prepareMatch(env, parseMatchInput(await readJson(request)))
    return json({ quote })
  }
  if (request.method === 'POST' && url.pathname === '/api/matches') return createMatch(request, env)
  const resume = url.pathname.match(/^\/api\/matches\/([a-f0-9-]{36})\/resume$/)
  if (request.method === 'POST' && resume) return resumeMatch(request, env, resume[1])
  const cancel = url.pathname.match(/^\/api\/matches\/([a-f0-9-]{36})\/cancel$/)
  if (request.method === 'POST' && cancel) return cancelMatch(request, env, cancel[1])
  return null
}
