import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../../worker/env'
import { HttpError } from '../../worker/http'
import { MatchRoom, PartySocket } from '../../worker/match-room'
import { SharedState, type JsonObject } from '../../worker/shared-state'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

interface FakePartySocket {
  shared: SharedState
  connected: boolean
  connect: ReturnType<typeof vi.fn>
  request: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
  waitForState: <T>(predicate: (shared: SharedState) => T | undefined) => Promise<T>
}

interface RoomInternals {
  match: Record<string, unknown>
  host: FakePartySocket
  guest: FakePartySocket
  expectedPlayerIds: number[]
  handleCommand: (command: JsonObject) => Promise<unknown>
  runCommand: (command: JsonObject) => Promise<unknown>
  runCancellation: () => Promise<void>
  publishState: () => Promise<void>
  queuePublish: () => void
  publishing: Promise<void>
  snapshot: () => Record<string, unknown>
  questionTiming: { identity: string; deadlineAt: number } | null
  observedQuestionIdentity: string | null
  acceptQuestionTransitions: boolean
  cancelling: boolean
  lastQuestionFingerprint: string | null
  resolveGameId: () => Promise<number | null>
  broadcast: ReturnType<typeof vi.fn>
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((fulfill) => { resolve = fulfill })
  return { promise, resolve }
}

function createSharedState(gameId: number | null): SharedState {
  const shared = new SharedState()
  shared.apply({ a: 0, t: '@SO', d: { a: 'C', k: 'party', v: { state: 'running' } } })
  shared.apply({
    a: 0,
    t: '@SL',
    d: { a: 'C', k: 'players', v: [{ id: 101 }, { id: 202 }] },
  })
  shared.apply({
    a: 0,
    t: '@SL',
    d: {
      a: 'C',
      k: 'games',
      v: gameId === null ? [] : [{ id: gameId, gameName: 'proximo', currentRound: 4, showAnswer: false }],
    },
  })
  if (gameId !== null) {
    shared.apply({
      a: gameId,
      t: '@SL',
      d: {
        a: 'C',
        k: 'scores',
        v: [{ id: 101, submitted: false }, { id: 202, submitted: false }],
      },
    })
  }
  return shared
}

function createParty(shared: SharedState): FakePartySocket {
  return {
    shared,
    connected: true,
    connect: vi.fn().mockResolvedValue(undefined),
    request: vi.fn(),
    disconnect: vi.fn(),
    waitForState: async <T>(predicate: (state: SharedState) => T | undefined): Promise<T> => {
      const result = predicate(shared)
      if (result === undefined) throw new Error('Fake state did not satisfy predicate')
      return result
    },
  }
}

function createHarness(gameId: number | null): {
  room: RoomInternals
  host: FakePartySocket
  guest: FakePartySocket
  storage: Map<string, unknown>
  state: DurableObjectState
  env: Env
  databaseRuns: ReturnType<typeof vi.fn>
  databasePrepare: ReturnType<typeof vi.fn>
  databaseFirst: ReturnType<typeof vi.fn>
  setAlarm: ReturnType<typeof vi.fn>
} {
  const storage = new Map<string, unknown>()
  const setAlarm = vi.fn()
  const state = {
    storage: {
      get: vi.fn(async (key: string) => storage.get(key)),
      put: vi.fn(async (key: string | Record<string, unknown>, value?: unknown) => {
        if (typeof key === 'string') storage.set(key, value)
        else for (const [entryKey, entryValue] of Object.entries(key)) storage.set(entryKey, entryValue)
      }),
      delete: vi.fn(async (key: string) => storage.delete(key)),
      list: vi.fn(async ({ prefix }: { prefix: string }) => new Map(
        [...storage].filter(([key]) => key.startsWith(prefix)),
      )),
      setAlarm,
    },
    getWebSockets: vi.fn(() => []),
  }
  const databaseRuns = vi.fn().mockResolvedValue({ success: true })
  const databaseFirst = vi.fn()
  const statement = {
    bind: vi.fn().mockReturnThis(),
    run: databaseRuns,
    first: databaseFirst,
  }
  const databasePrepare = vi.fn(() => statement)
  const env = { DB: { prepare: databasePrepare } } as unknown as Env
  const instance = new MatchRoom(state as unknown as DurableObjectState, env)
  const host = createParty(createSharedState(gameId))
  const guest = createParty(createSharedState(gameId))
  const room = instance as unknown as RoomInternals
  room.match = {
    id: 'match-id',
    status: 'playing',
    host_account_id: 'host-account',
    guest_account_id: 'guest-account',
    team_a_json: JSON.stringify({ accountId: 'host-account' }),
    team_b_json: JSON.stringify({ accountId: 'guest-account' }),
    content_slug: '300',
    duration_minutes: 15,
    game_mode: 'proximo',
    rounds: null,
    game_id: gameId,
  }
  room.host = host
  room.guest = guest
  room.expectedPlayerIds = [101, 202]
  room.acceptQuestionTransitions = true
  room.broadcast = vi.fn()
  return { room, host, guest, storage, state: state as unknown as DurableObjectState, env, databaseRuns, databasePrepare, databaseFirst, setAlarm }
}

function activateQuestion(
  room: RoomInternals,
  host: FakePartySocket,
  storage: Map<string, unknown>,
  deadlineAt = Date.now() + 30_000,
): void {
  host.shared.apply({ a: 0, t: '@SL', d: { a: 'P', k: 'games', n: 0, p: 'question', v: 'How many?' } })
  host.shared.apply({ a: 0, t: '@SL', d: { a: 'P', k: 'games', n: 0, p: 'questionDurationSeconds', v: 30 } })
  const timing = { identity: '7:4:How many?', deadlineAt }
  room.questionTiming = timing
  storage.set('questionTiming', timing)
}

function activateTtmcRound(
  room: RoomInternals,
  host: FakePartySocket,
  guest: FakePartySocket,
  round: Record<string, unknown> = { id: 12, gameName: 'ttmc-round', state: 'running', played: [], total: 10 },
): void {
  room.match.game_mode = 'ttmc'
  room.match.rounds = 10
  for (const party of [host, guest]) {
    party.shared.apply({ a: 0, t: '@SL', d: { a: 'C', k: 'rounds', v: [round] } })
    party.shared.apply({ a: Number(round.id), t: '@SL', d: { a: 'C', k: 'scores', v: [] } })
  }
}

function addTtmcScore(host: FakePartySocket, guest: FakePartySocket, id: number, difficulty: number): void {
  for (const party of [host, guest]) {
    party.shared.apply({ a: 12, t: '@SL', d: { a: 'A', k: 'scores', v: { id, difficulty, success: null, points: 0 } } })
  }
}

describe('MatchRoom command ordering', () => {
  it('serializes commands from concurrent browser clients', async () => {
    const { room } = createHarness(7)
    const release = deferred<void>()
    const order: string[] = []
    room.handleCommand = vi.fn()
      .mockImplementationOnce(async () => {
        order.push('first-start')
        await release.promise
        order.push('first-end')
        return 'first'
      })
      .mockImplementationOnce(async () => {
        order.push('second')
        return 'second'
      })

    const first = room.runCommand({ type: 'ready' })
    const second = room.runCommand({ type: 'finish' })
    await vi.waitFor(() => expect(order).toEqual(['first-start']))
    release.resolve()

    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second'])
    expect(order).toEqual(['first-start', 'first-end', 'second'])
  })

  it('accepts the synchronized game frame before the add-game response', async () => {
    const { room, host, storage, databaseRuns } = createHarness(null)
    const upstream = deferred<unknown>()
    host.request.mockReturnValueOnce(upstream.promise)

    const result = room.handleCommand({ type: 'start-proximo' })
    await vi.waitFor(() => expect(host.request).toHaveBeenCalledWith(0, 'add-game', {
      gameName: 'proximo',
      config: { contents: ['300'] },
    }))

    host.shared.apply({
      a: 0,
      t: '@SL',
      d: { a: 'M', k: 'games', n: 0, v: { id: 9, gameName: 'proximo' } },
    })
    expect(host.shared.list(0, 'games')).toEqual([])
    host.shared.apply({
      a: 0,
      t: '@SL',
      d: { a: 'A', k: 'games', v: { id: 9, gameName: 'proximo' } },
    })
    host.shared.apply({ a: 9, t: '@SO', d: { a: 'C', k: 'game', v: { currentRound: 1 } } })
    host.shared.apply({ a: 9, t: '@SL', d: { a: 'C', k: 'scores', v: [] } })
    upstream.resolve('success')

    await expect(result).resolves.toBe('success')
    expect(room.match.game_id).toBe(9)
    expect(storage.has('proximoAddRequested')).toBe(false)
    expect(databaseRuns).toHaveBeenCalledOnce()
  })

  it('rejects invalid Proximo content before recording or sending a mutation', async () => {
    const { room, host, storage } = createHarness(null)
    room.match.content_slug = ''

    await expect(room.handleCommand({ type: 'start-proximo' }))
      .rejects.toMatchObject({ code: 'match-data-invalid' })
    expect(host.request).not.toHaveBeenCalled()
    expect(storage.has('proximoAddRequested')).toBe(false)
  })

  it('submits both team answers in parallel with per-player deduplication', async () => {
    const { room, host, guest, storage } = createHarness(7)
    activateQuestion(room, host, storage)
    host.request.mockResolvedValue({ delta: -4, answer: 6 })
    guest.request.mockResolvedValue({ delta: -1, answer: 6 })

    await expect(room.handleCommand({ type: 'answers', gameId: 7, currentRound: 4, answers: { a: 2, b: 5 } }))
      .resolves.toEqual(['accepted', 'accepted'])
    expect(host.request).toHaveBeenCalledWith(7, 'answer', 2)
    expect(guest.request).toHaveBeenCalledWith(7, 'answer', 5)
    expect(storage.get('answer:7:4:101')).toEqual({ answer: 2, status: 'accepted' })
    expect(storage.get('answer:7:4:202')).toEqual({ answer: 5, status: 'accepted' })

    await room.handleCommand({ type: 'answers', gameId: 7, currentRound: 4, answers: { a: 2, b: 5 } })
    expect(host.request).toHaveBeenCalledOnce()
    expect(guest.request).toHaveBeenCalledOnce()

    await expect(room.handleCommand({ type: 'answers', gameId: 7, currentRound: 4, answers: { a: 3, b: 5 } }))
      .rejects.toMatchObject({ code: 'answer-conflict' })
    expect(host.request).toHaveBeenCalledOnce()
  })

  it('adds an all-category next question without confusing finished game history', async () => {
    const { room, host, storage, databaseRuns } = createHarness(7)
    room.match.content_slug = 'all'
    host.shared.apply({ a: 0, t: '@SL', d: { a: 'P', k: 'games', n: 0, p: 'showAnswer', v: true } })
    host.shared.apply({ a: 0, t: '@SL', d: { a: 'P', k: 'games', n: 0, p: 'state', v: 'finished' } })
    const upstream = deferred<unknown>()
    host.request.mockReturnValueOnce(upstream.promise)

    const result = room.handleCommand({ type: 'next-proximo', gameId: 7 })
    await vi.waitFor(() => expect(host.request).toHaveBeenCalledWith(0, 'add-game', {
      gameName: 'proximo',
      config: { contents: ['300', '299', 'geographie', 'sciences'] },
    }))
    host.shared.apply({
      a: 0,
      t: '@SL',
      d: { a: 'A', k: 'games', v: { id: 9, gameName: 'proximo', currentRound: -1, showAnswer: false } },
    })
    host.shared.apply({ a: 9, t: '@SL', d: { a: 'C', k: 'scores', v: [] } })
    upstream.resolve('success')

    await expect(result).resolves.toBe('success')
    expect(room.match.game_id).toBe(9)
    expect(storage.has('proximoAddRequested')).toBe(false)
    expect(databaseRuns).toHaveBeenCalledOnce()
  })

  it('does not continue from a finished label before authoritative reveal', async () => {
    const { room, host } = createHarness(7)
    host.shared.apply({ a: 0, t: '@SL', d: { a: 'P', k: 'games', n: 0, p: 'state', v: 'finished' } })

    await expect(room.handleCommand({ type: 'next-proximo', gameId: 7 }))
      .rejects.toMatchObject({ code: 'game-not-finished' })
    expect(host.request).not.toHaveBeenCalled()
  })

  it('does not continue after reveal until the game is authoritatively finished', async () => {
    const { room, host } = createHarness(7)
    host.shared.apply({ a: 0, t: '@SL', d: { a: 'P', k: 'games', n: 0, p: 'showAnswer', v: true } })
    host.shared.apply({ a: 0, t: '@SL', d: { a: 'P', k: 'games', n: 0, p: 'state', v: 'running' } })

    await expect(room.handleCommand({ type: 'next-proximo', gameId: 7 }))
      .rejects.toMatchObject({ code: 'game-not-finished' })
    expect(host.request).not.toHaveBeenCalled()
  })

  it('persists one deadline per question and clears it on reveal', async () => {
    const { room, host, storage } = createHarness(7)
    host.shared.apply({ a: 0, t: '@SL', d: { a: 'P', k: 'games', n: 0, p: 'question', v: 'How many?' } })
    host.shared.apply({ a: 0, t: '@SL', d: { a: 'P', k: 'games', n: 0, p: 'questionDurationSeconds', v: 30 } })

    await room.publishState()
    const first = (room.snapshot().game as { questionDeadlineAt: number }).questionDeadlineAt
    expect(first).toBeGreaterThan(Date.now())
    expect(storage.get('questionTiming')).toEqual({ identity: '7:4:How many?', deadlineAt: first })

    await room.publishState()
    expect((room.snapshot().game as { questionDeadlineAt: number }).questionDeadlineAt).toBe(first)

    host.shared.apply({ a: 0, t: '@SL', d: { a: 'P', k: 'games', n: 0, p: 'showAnswer', v: true } })
    await room.publishState()
    expect((room.snapshot().game as { questionDeadlineAt: null }).questionDeadlineAt).toBeNull()
    expect(storage.has('questionTiming')).toBe(false)
  })

  it('keeps a restored deadline while the host is resynchronizing', async () => {
    const { room, host, storage } = createHarness(7)
    const timing = { identity: '7:4:How many?', deadlineAt: Date.now() + 20_000 }
    room.questionTiming = timing
    storage.set('questionTiming', timing)
    host.connected = false
    host.shared = new SharedState()

    await room.publishState()

    expect(room.questionTiming).toEqual(timing)
    expect(storage.get('questionTiming')).toEqual(timing)
  })

  it('fails closed when an active timed question is first discovered during synchronization', async () => {
    const { room, host, storage } = createHarness(7)
    room.acceptQuestionTransitions = false
    host.shared.apply({ a: 0, t: '@SL', d: { a: 'P', k: 'games', n: 0, p: 'question', v: 'Already running' } })
    host.shared.apply({ a: 0, t: '@SL', d: { a: 'P', k: 'games', n: 0, p: 'questionDurationSeconds', v: 30 } })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await room.publishState()
    room.acceptQuestionTransitions = true
    await room.publishState()

    expect((room.snapshot().game as { questionDeadlineAt: unknown }).questionDeadlineAt).toBeNull()
    expect(storage.has('questionTiming')).toBe(false)
    await expect(room.handleCommand({
      type: 'answers', gameId: 7, currentRound: 4, answers: { a: 1 },
    })).rejects.toMatchObject({ code: 'question-deadline-missing' })
    expect(host.request).not.toHaveBeenCalled()
    expect(warning).toHaveBeenCalledWith('Refusing to create a deadline for a question first discovered during synchronization')
    warning.mockRestore()
  })

  it('finishes local state without repeating an already-finished upstream command', async () => {
    const { room, host, databaseRuns } = createHarness(7)
    host.shared.apply({ a: 0, t: '@SO', d: { a: 'M', k: 'party', n: 'state', v: 'finished' } })

    await expect(room.handleCommand({ type: 'finish' })).resolves.toBe('already-finished')
    expect(host.request).not.toHaveBeenCalled()
    expect(room.match.status).toBe('finished')
    expect(databaseRuns).toHaveBeenCalledOnce()
  })

  it('keeps answers and deltas secret until showAnswer is authoritative', async () => {
    const { room, host, storage } = createHarness(7)
    activateQuestion(room, host, storage)
    host.shared.apply({ a: 0, t: '@SL', d: { a: 'P', k: 'players', n: 0, p: 'score', v: 5 } })
    host.shared.apply({ a: 0, t: '@SL', d: { a: 'P', k: 'games', n: 0, p: 'answer', v: 6 } })
    host.shared.apply({ a: 7, t: '@SL', d: { a: 'P', k: 'scores', n: 0, p: 'answer', v: 4 } })
    host.shared.apply({ a: 7, t: '@SL', d: { a: 'P', k: 'scores', n: 0, p: 'answerDelta', v: -2 } })
    host.shared.apply({ a: 7, t: '@SL', d: { a: 'P', k: 'scores', n: 1, p: 'answer', v: 8 } })
    host.shared.apply({ a: 7, t: '@SL', d: { a: 'P', k: 'scores', n: 1, p: 'answerDelta', v: 2 } })

    await room.publishState()
    const hidden = room.snapshot().game as {
      showAnswer: boolean
      answer: unknown
      questionDeadlineAt: number
      scores: Array<{ answer: unknown, delta: unknown }>
    }
    expect(hidden.showAnswer).toBe(false)
    expect(hidden.answer).toBeNull()
    expect((room.snapshot().players as Array<{ score: unknown }>)[0].score).toBeNull()
    expect(hidden.scores).toEqual([
      expect.objectContaining({ answer: null, delta: null }),
      expect.objectContaining({ answer: null, delta: null }),
    ])
    expect(hidden.questionDeadlineAt).toBeGreaterThan(Date.now())
    expect(storage.has('questionTiming')).toBe(true)

    host.shared.apply({ a: 0, t: '@SL', d: { a: 'P', k: 'games', n: 0, p: 'showAnswer', v: true } })
    await room.publishState()
    const revealed = room.snapshot().game as {
      showAnswer: boolean
      answer: number
      questionDeadlineAt: null
      scores: Array<{ answer: number, delta: number }>
    }
    expect(revealed.showAnswer).toBe(true)
    expect(revealed.answer).toBe(6)
    expect((room.snapshot().players as Array<{ score: unknown }>)[0].score).toBe(5)
    expect(revealed.scores).toEqual([
      expect.objectContaining({ answer: 4, delta: -2 }),
      expect.objectContaining({ answer: 8, delta: 2 }),
    ])
    expect(revealed.questionDeadlineAt).toBeNull()
    expect(storage.has('questionTiming')).toBe(false)
  })

  it('does not resend or overwrite an ambiguous durable add-game request', async () => {
    const { room, host, storage } = createHarness(7)
    const marker = { beforeGameIds: [7] }
    storage.set('proximoAddRequested', marker)
    host.shared.apply({ a: 0, t: '@SL', d: { a: 'P', k: 'games', n: 0, p: 'showAnswer', v: true } })

    await expect(room.resolveGameId()).rejects.toMatchObject({ code: 'proximo-add-pending' })
    await expect(room.handleCommand({ type: 'start-proximo' })).rejects.toMatchObject({ code: 'proximo-add-pending' })
    await expect(room.handleCommand({ type: 'next-proximo', gameId: 7 })).rejects.toMatchObject({ code: 'proximo-add-pending' })
    expect(host.request).not.toHaveBeenCalled()
    expect(storage.get('proximoAddRequested')).toBe(marker)
  })

  it('retains mutation markers for ambiguous add-game, TTMC round, and TTMC answer responses', async () => {
    const proximo = createHarness(7)
    proximo.host.request.mockResolvedValue({ status: 'unknown' })
    await expect(proximo.room.handleCommand({ type: 'next-proximo', gameId: 7 })).rejects.toMatchObject({
      code: 'game-not-finished',
    })
    proximo.host.shared.apply({ a: 0, t: '@SL', d: { a: 'P', k: 'games', n: 0, p: 'showAnswer', v: true } })
    proximo.host.shared.apply({ a: 0, t: '@SL', d: { a: 'P', k: 'games', n: 0, p: 'state', v: 'finished' } })
    await expect(proximo.room.handleCommand({ type: 'next-proximo', gameId: 7 })).rejects.toMatchObject({
      code: 'proximo-add-outcome-unknown',
    })
    expect(proximo.storage.get('proximoAddRequested')).toEqual({ beforeGameIds: [7] })

    const ttmc = createHarness(null)
    activateTtmcRound(ttmc.room, ttmc.host, ttmc.guest, { id: 12, gameName: 'ttmc-round', state: 'finished', played: [], total: 10 })
    ttmc.host.request.mockResolvedValue({ status: 'unknown' })
    await expect(ttmc.room.handleCommand({ type: 'next-ttmc-round', roundId: 12 })).rejects.toMatchObject({
      code: 'round-start-outcome-unknown',
    })
    expect(ttmc.storage.get('ttmc:next:12')).toEqual({ beforeRoundIds: [12] })

    const answer = createHarness(null)
    activateTtmcRound(answer.room, answer.host, answer.guest)
    addTtmcScore(answer.host, answer.guest, 101, 4)
    answer.storage.set('ttmc:question:12:101', {
      raw: { question: 'True?', answers: { selected: 'bool', answer: true } },
      public: { type: 'bool', prompt: 'True?' },
    })
    answer.host.request.mockResolvedValue({ status: 'unknown' })
    await expect(answer.room.handleCommand({ type: 'ttmc-answers', roundId: 12, answers: { a: true } })).rejects.toMatchObject({
      code: 'answer-outcome-unknown',
    })
    expect(answer.storage.get('ttmc:answer:12:101')).toEqual({ status: 'pending', value: true })
  })

  it('does not reconcile a pending add-game marker from a new non-Proximo game ID', async () => {
    const { room, host, storage } = createHarness(7)
    storage.set('proximoAddRequested', { beforeGameIds: [7] })
    host.shared.apply({
      a: 0,
      t: '@SL',
      d: { a: 'A', k: 'games', v: { id: 9, gameName: 'ttmc-round' } },
    })

    await expect(room.resolveGameId()).rejects.toMatchObject({ code: 'proximo-add-pending' })
    expect(room.match.game_id).toBe(7)
    expect(storage.get('proximoAddRequested')).toEqual({ beforeGameIds: [7] })
  })

  it('rejects stale ready, answers, and next commands before upstream calls', async () => {
    const { room, host, guest, storage } = createHarness(7)
    activateQuestion(room, host, storage)
    host.shared.apply({ a: 0, t: '@SL', d: { a: 'P', k: 'games', n: 0, p: 'showAnswer', v: true } })

    await expect(room.handleCommand({ type: 'ready', gameId: 6 })).rejects.toMatchObject({ code: 'game-id-mismatch' })
    await expect(room.handleCommand({ type: 'answers', gameId: 7, currentRound: 3, answers: { a: 1 } }))
      .rejects.toMatchObject({ code: 'current-round-mismatch' })
    await expect(room.handleCommand({ type: 'next-proximo', gameId: 6 })).rejects.toMatchObject({ code: 'game-id-mismatch' })
    await expect(room.handleCommand({ type: 'ready' })).rejects.toMatchObject({ code: 'invalid-game-id' })
    await expect(room.handleCommand({ type: 'answers', gameId: 7, currentRound: '4', answers: { a: 1 } }))
      .rejects.toMatchObject({ code: 'invalid-current-round' })
    await expect(room.handleCommand({ type: 'answers', gameId: 7, currentRound: -1, answers: { a: 1 } }))
      .rejects.toMatchObject({ code: 'invalid-current-round' })
    expect(host.request).not.toHaveBeenCalled()
    expect(guest.request).not.toHaveBeenCalled()
  })

  it('accepts partial answer batches without coercing JSON values', async () => {
    const { room, host, guest, storage } = createHarness(7)
    activateQuestion(room, host, storage)
    host.request.mockResolvedValue({ delta: -4, answer: 6 })

    await expect(room.handleCommand({ type: 'answers', gameId: 7, currentRound: 4, answers: { a: 2 } }))
      .resolves.toEqual(['accepted'])
    expect(host.request).toHaveBeenCalledWith(7, 'answer', 2)
    expect(guest.request).not.toHaveBeenCalled()

    for (const answers of [{}, { a: '2' }, { b: 1.5 }, { a: -1 }]) {
      await expect(room.handleCommand({ type: 'answers', gameId: 7, currentRound: 4, answers }))
        .rejects.toMatchObject({ code: 'invalid-answers' })
    }
    expect(host.request).toHaveBeenCalledOnce()
  })

  it('rejects answers outside an active running question and deadline', async () => {
    const expired = createHarness(7)
    activateQuestion(expired.room, expired.host, expired.storage, Date.now() - 1)
    await expect(expired.room.handleCommand({
      type: 'answers', gameId: 7, currentRound: 4, answers: { a: 1 },
    })).rejects.toMatchObject({ code: 'answer-deadline-expired' })
    expect(expired.host.request).not.toHaveBeenCalled()

    const revealed = createHarness(7)
    activateQuestion(revealed.room, revealed.host, revealed.storage)
    revealed.host.shared.apply({ a: 0, t: '@SL', d: { a: 'P', k: 'games', n: 0, p: 'showAnswer', v: true } })
    await expect(revealed.room.handleCommand({
      type: 'answers', gameId: 7, currentRound: 4, answers: { a: 1 },
    })).rejects.toMatchObject({ code: 'question-revealed' })

    const missingQuestion = createHarness(7)
    await expect(missingQuestion.room.handleCommand({
      type: 'answers', gameId: 7, currentRound: 4, answers: { a: 1 },
    })).rejects.toMatchObject({ code: 'question-not-active' })

    const invalidRound = createHarness(7)
    invalidRound.host.shared.apply({ a: 0, t: '@SL', d: { a: 'P', k: 'games', n: 0, p: 'currentRound', v: -1 } })
    await expect(invalidRound.room.handleCommand({
      type: 'answers', gameId: 7, currentRound: 0, answers: { a: 1 },
    })).rejects.toMatchObject({ code: 'game-round-not-synchronized' })

    const waiting = createHarness(7)
    waiting.host.shared.apply({ a: 0, t: '@SO', d: { a: 'M', k: 'party', n: 'state', v: 'waiting' } })
    for (const command of [
      { type: 'start-proximo' },
      { type: 'next-proximo', gameId: 7 },
      { type: 'ready', gameId: 7 },
      { type: 'answers', gameId: 7, currentRound: 4, answers: { a: 1 } },
      { type: 'finish' },
    ]) {
      await expect(waiting.room.handleCommand(command)).rejects.toMatchObject({ code: 'party-not-running' })
    }
    expect(waiting.host.request).not.toHaveBeenCalled()
    expect(waiting.guest.request).not.toHaveBeenCalled()
  })

  it('only finishes after authoritative party completion', async () => {
    const accepted = createHarness(null)
    accepted.host.request.mockImplementation(async () => {
      accepted.host.shared.apply({ a: 0, t: '@SO', d: { a: 'M', k: 'party', n: 'state', v: 'finished' } })
      return 'no-running-game'
    })

    await expect(accepted.room.handleCommand({ type: 'finish' })).resolves.toBe('no-running-game')
    expect(accepted.host.request).toHaveBeenCalledWith(0, 'finish-current-game', null)
    expect(accepted.room.match.status).toBe('finished')
    expect(accepted.databaseRuns).toHaveBeenCalledOnce()

    const rejected = createHarness(null)
    rejected.host.request.mockResolvedValue('unexpected')
    await expect(rejected.room.handleCommand({ type: 'finish' })).rejects.toMatchObject({ code: 'finish-rejected' })
    expect(rejected.room.match.status).toBe('playing')
    expect(rejected.databaseRuns).not.toHaveBeenCalled()
  })

  it('cancels through the guest once and persists a retry-safe terminal snapshot', async () => {
    const { room, host, guest, storage, databaseRuns } = createHarness(null)
    guest.request.mockResolvedValue('ok')

    await expect(room.runCancellation()).resolves.toBeUndefined()

    expect(guest.request).toHaveBeenCalledWith(0, 'give-up', undefined)
    expect(host.disconnect).toHaveBeenCalledOnce()
    expect(guest.disconnect).toHaveBeenCalledOnce()
    expect(room.match.status).toBe('cancelled')
    expect(storage.has('cancelAction')).toBe(false)
    expect(storage.get('terminalSnapshot')).toMatchObject({ id: 'match-id', status: 'cancelled', connected: false })
    expect(databaseRuns).toHaveBeenCalledOnce()
  })

  it('starts an empty waiting TTMC party before cancelling it', async () => {
    const { room, host, guest } = createHarness(null)
    room.match.game_mode = 'ttmc'
    room.match.rounds = 2
    host.shared.apply({ a: 0, t: '@SL', d: { a: 'C', k: 'rounds', v: [] } })
    host.shared.apply({ a: 0, t: '@SO', d: { a: 'M', k: 'party', n: 'state', v: 'waiting' } })
    host.request.mockImplementation(async (_app, type) => {
      if (type === 'start-round') host.shared.apply({
        a: 0, t: '@SL', d: { a: 'A', k: 'rounds', v: { id: 1, gameName: 'ttmc-round' } },
      })
      return 'success'
    })
    guest.request.mockResolvedValue('ok')

    await expect(room.runCancellation()).resolves.toBeUndefined()
    expect(host.request).toHaveBeenCalledWith(0, 'start-round', undefined)
    expect(guest.request).toHaveBeenCalledWith(0, 'give-up', undefined)
  })

  it('cancels without recovering an unsupported TTMC question', async () => {
    const { room, host, guest, storage } = createHarness(null)
    room.match.game_mode = 'ttmc'
    room.match.rounds = 2
    activateTtmcRound(room, host, guest)
    addTtmcScore(host, guest, 101, 4)
    storage.set('ttmc:start:12:101', { difficulty: 4 })
    host.request.mockResolvedValue({ question: 'Unknown', answers: { selected: 'future-schema' } })
    guest.request.mockResolvedValue('ok')

    await expect(room.runCancellation()).resolves.toBeUndefined()

    expect(host.request).not.toHaveBeenCalled()
    expect(guest.request).toHaveBeenCalledWith(0, 'give-up', undefined)
    expect(room.match.status).toBe('cancelled')
  })

  it('releases a match only when Grooop confirms that its lobby no longer exists', async () => {
    const missing = createHarness(null)
    missing.host.connect.mockRejectedValue(new HttpError(
      410,
      'party-lobby-not-found',
      'Grooop rejected the party connection: lobby-not-found',
    ))

    await expect(missing.room.runCancellation()).resolves.toBeUndefined()
    expect(missing.guest.request).not.toHaveBeenCalled()
    expect(missing.room.match.status).toBe('cancelled')
    expect(missing.storage.get('terminalSnapshot')).toMatchObject({ status: 'cancelled', connected: false })

    const rejected = createHarness(null)
    rejected.host.connect.mockRejectedValue(new HttpError(
      502,
      'party-socket-rejected',
      'Grooop rejected the party connection: unauthorized',
    ))

    await expect(rejected.room.runCancellation()).rejects.toMatchObject({ code: 'party-socket-rejected' })
    expect(rejected.room.match.status).toBe('playing')
    expect(rejected.databaseRuns).not.toHaveBeenCalled()
  })

  it('keeps an unresolved cancellation live and resumes state reconciliation', async () => {
    const { room, guest, storage, databasePrepare } = createHarness(null)
    guest.request.mockRejectedValue(new Error('socket closed'))

    await expect(room.runCancellation()).rejects.toMatchObject({ code: 'match-cancel-outcome-unknown' })
    await room.publishing
    expect(storage.get('cancelAction')).toEqual({ status: 'pending' })
    expect(room.match.status).toBe('waiting')
    expect(room.cancelling).toBe(false)
    expect(databasePrepare).not.toHaveBeenCalledWith(expect.stringContaining('finished_at'))
  })

  it('blocks replay when answer, ready, or finish outcomes are unknown', async () => {
    const answer = createHarness(7)
    activateQuestion(answer.room, answer.host, answer.storage)
    answer.host.request.mockRejectedValue(new Error('response lost'))
    await expect(answer.room.handleCommand({
      type: 'answers', gameId: 7, currentRound: 4, answers: { a: 2 },
    })).rejects.toThrow('response lost')
    await expect(answer.room.handleCommand({
      type: 'answers', gameId: 7, currentRound: 4, answers: { a: 2 },
    })).rejects.toMatchObject({ code: 'answer-outcome-unknown' })
    expect(answer.host.request).toHaveBeenCalledOnce()

    const ready = createHarness(7)
    ready.host.request.mockRejectedValue(new Error('response lost'))
    ready.guest.request.mockResolvedValue('ok')
    await expect(ready.room.handleCommand({ type: 'ready', gameId: 7 })).rejects.toThrow('response lost')
    await expect(ready.room.handleCommand({ type: 'ready', gameId: 7 }))
      .rejects.toMatchObject({ code: 'ready-outcome-unknown' })
    expect(ready.host.request).toHaveBeenCalledOnce()
    expect(ready.guest.request).toHaveBeenCalledOnce()

    const finish = createHarness(null)
    finish.host.request.mockResolvedValue('no-running-game')
    await expect(finish.room.handleCommand({ type: 'finish' }))
      .rejects.toMatchObject({ code: 'finish-outcome-unknown' })
    await expect(finish.room.handleCommand({ type: 'finish' }))
      .rejects.toMatchObject({ code: 'finish-outcome-unknown' })
    expect(finish.host.request).toHaveBeenCalledOnce()
    expect(finish.room.match.status).toBe('playing')
  })

  it('clears pending Proximo markers only for explicit rejection responses', async () => {
    const rejectedAnswer = createHarness(7)
    activateQuestion(rejectedAnswer.room, rejectedAnswer.host, rejectedAnswer.storage)
    rejectedAnswer.host.request.mockResolvedValue(false)
    await expect(rejectedAnswer.room.handleCommand({
      type: 'answers', gameId: 7, currentRound: 4, answers: { a: 2 },
    })).rejects.toMatchObject({ code: 'answer-rejected' })
    expect(rejectedAnswer.storage.has('answer:7:4:101')).toBe(false)

    const malformedAnswer = createHarness(7)
    activateQuestion(malformedAnswer.room, malformedAnswer.host, malformedAnswer.storage)
    malformedAnswer.host.request.mockResolvedValue({ accepted: true })
    await expect(malformedAnswer.room.handleCommand({
      type: 'answers', gameId: 7, currentRound: 4, answers: { a: 2 },
    })).rejects.toMatchObject({ code: 'answer-outcome-unknown' })
    expect(malformedAnswer.storage.get('answer:7:4:101')).toEqual({ answer: 2, status: 'pending' })

    const rejectedReady = createHarness(7)
    rejectedReady.host.request.mockResolvedValue('rejected')
    rejectedReady.guest.request.mockResolvedValue('ok')
    await expect(rejectedReady.room.handleCommand({ type: 'ready', gameId: 7 }))
      .rejects.toMatchObject({ code: 'ready-rejected' })
    expect(rejectedReady.storage.has('ready:7:101')).toBe(false)
    expect(rejectedReady.storage.get('ready:7:202')).toEqual({ status: 'accepted' })

    const malformedReady = createHarness(7)
    malformedReady.host.request.mockResolvedValue({ status: 'ok' })
    malformedReady.guest.request.mockResolvedValue('ok')
    await expect(malformedReady.room.handleCommand({ type: 'ready', gameId: 7 }))
      .rejects.toMatchObject({ code: 'ready-outcome-unknown' })
    expect(malformedReady.storage.get('ready:7:101')).toEqual({ status: 'pending' })

    const rejectedFinish = createHarness(null)
    rejectedFinish.host.request.mockResolvedValue('rejected')
    await expect(rejectedFinish.room.handleCommand({ type: 'finish' }))
      .rejects.toMatchObject({ code: 'finish-rejected' })
    expect(rejectedFinish.storage.has('finishAction')).toBe(false)

    const malformedFinish = createHarness(null)
    malformedFinish.host.request.mockResolvedValue({ status: 'success' })
    await expect(malformedFinish.room.handleCommand({ type: 'finish' }))
      .rejects.toMatchObject({ code: 'finish-outcome-unknown' })
    expect(malformedFinish.storage.get('finishAction')).toEqual({ status: 'pending' })
  })

  it('accepts only the observed Proximo answer success object', async () => {
    const accepted = createHarness(7)
    activateQuestion(accepted.room, accepted.host, accepted.storage)
    accepted.host.request.mockResolvedValue({ answer: 6, delta: -4 })
    await expect(accepted.room.handleCommand({
      type: 'answers', gameId: 7, currentRound: 4, answers: { a: 2 },
    })).resolves.toEqual(['accepted'])

    const truthyPrimitive = createHarness(7)
    activateQuestion(truthyPrimitive.room, truthyPrimitive.host, truthyPrimitive.storage)
    truthyPrimitive.host.request.mockResolvedValue('success')
    await expect(truthyPrimitive.room.handleCommand({
      type: 'answers', gameId: 7, currentRound: 4, answers: { a: 2 },
    })).rejects.toMatchObject({ code: 'answer-outcome-unknown' })
    expect(truthyPrimitive.storage.get('answer:7:4:101')).toEqual({ answer: 2, status: 'pending' })
  })

  it('skips and logs malformed extra players and scores in public snapshots', () => {
    const { room, host } = createHarness(7)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    host.shared.apply({ a: 0, t: '@SL', d: { a: 'A', k: 'players', v: null } })
    host.shared.apply({ a: 0, t: '@SL', d: { a: 'A', k: 'players', v: { id: 'extra', score: 'poison' } } })
    host.shared.apply({ a: 7, t: '@SL', d: { a: 'A', k: 'scores', v: [] } })
    host.shared.apply({ a: 7, t: '@SL', d: { a: 'A', k: 'scores', v: { answer: 99, answerDelta: 99 } } })
    host.shared.apply({ a: 7, t: '@SL', d: { a: 'A', k: 'scores', v: { id: 303, answer: { poison: true } } } })

    const snapshot = room.snapshot()

    expect(snapshot.players).toHaveLength(2)
    expect((snapshot.game as { scores: unknown[] }).scores).toHaveLength(2)
    expect(warning).toHaveBeenCalledWith('Skipping malformed synchronized player')
    expect(warning).toHaveBeenCalledWith('Skipping malformed synchronized score')
    warning.mockRestore()
  })

  it('waits for both answer submissions before releasing command serialization', async () => {
    const { room, host, guest, storage } = createHarness(7)
    activateQuestion(room, host, storage)
    const slowGuest = deferred<unknown>()
    host.request.mockRejectedValue(new Error('host failed'))
    guest.request.mockReturnValue(slowGuest.promise)

    const answers = room.runCommand({ type: 'answers', gameId: 7, currentRound: 4, answers: { a: 2, b: 5 } })
    const finish = room.runCommand({ type: 'finish' })
    await vi.waitFor(() => expect(host.request).toHaveBeenCalledOnce())
    expect(finish).not.toBeUndefined()
    expect(host.request).toHaveBeenCalledOnce()
    slowGuest.resolve({ answer: 5 })
    await expect(answers).rejects.toThrow('host failed')
    await expect(finish).rejects.toMatchObject({ code: 'finish-outcome-unknown' })
  })

  it('stores the terminal snapshot before projecting authoritative party completion to D1', async () => {
    const completed = createHarness(7)
    completed.host.shared.apply({ a: 0, t: '@SO', d: { a: 'M', k: 'party', n: 'state', v: 'finished' } })
    await completed.room.publishState()
    expect(completed.room.match.status).toBe('finished')
    expect(completed.databasePrepare).toHaveBeenCalledWith(expect.stringContaining('finished_at'))
    expect(completed.storage.get('terminalSnapshot')).toMatchObject({
      id: 'match-id',
      status: 'finished',
      party: { state: 'finished' },
    })

    expect(completed.storage.get('terminalSnapshot')).toMatchObject({ status: 'finished', connected: false })
  })

  it('retries terminal D1 projection from an alarm after a failure and restart', async () => {
    const harness = createHarness(7)
    harness.storage.set('matchId', 'match-id')
    harness.host.shared.apply({ a: 0, t: '@SO', d: { a: 'M', k: 'party', n: 'state', v: 'finished' } })
    harness.databaseRuns.mockRejectedValueOnce(new Error('database unavailable'))

    await harness.room.publishState()
    expect(harness.storage.get('terminalSnapshot')).toMatchObject({ status: 'finished' })
    expect(harness.room.match.status).toBe('playing')
    expect(harness.setAlarm).toHaveBeenCalledWith(expect.any(Number))
    // A new object instance gets only durable storage, then projects without sockets.
    harness.databaseFirst.mockResolvedValue(harness.room.match)
    const restarted = new MatchRoom(harness.state, harness.env) as unknown as { alarm: () => Promise<void>, match: Record<string, unknown> | null }
    await restarted.alarm()

    expect(harness.databaseRuns).toHaveBeenCalledTimes(2)
    expect(restarted.match?.status).toBe('finished')
  })

  it('serves a persisted terminal snapshot after a room restart', async () => {
    const terminal = {
      id: 'match-id',
      status: 'finished',
      party: { state: 'finished', playerCount: 2 },
      players: [],
      teams: { a: {}, b: {} },
      gameMode: 'proximo',
      game: null,
      connected: false,
    }
    const storage = new Map<string, unknown>([
      ['matchId', 'match-id'],
      ['terminalSnapshot', terminal],
    ])
    const state = {
      storage: {
        get: vi.fn(async (key: string) => storage.get(key)),
        setAlarm: vi.fn(),
      },
    }
    const statement = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({
        id: 'match-id',
        status: 'playing',
        host_account_id: 'host-account',
        guest_account_id: 'guest-account',
        team_a_json: '{}',
        team_b_json: '{}',
        content_slug: '300',
        party_code_ciphertext: null,
        party_code_nonce: null,
        party_code_key_version: null,
        game_id: 7,
        game_mode: 'proximo',
        rounds: null,
      }),
    }
    const env = { DB: { prepare: vi.fn(() => statement) } } as unknown as Env
    const room = new MatchRoom(state as unknown as DurableObjectState, env)

    const response = await room.fetch(new Request('https://match.internal/state'))
    await expect(response.json()).resolves.toEqual({ match: terminal })
    expect(env.DB.prepare).toHaveBeenCalledTimes(2)
  })

  it('broadcasts revealed state when archival fails and retries the insert later', async () => {
    const { room, host, databaseRuns } = createHarness(7)
    room.match.status = 'revealed'
    host.shared.apply({ a: 0, t: '@SL', d: { a: 'P', k: 'games', n: 0, p: 'question', v: 'How many?' } })
    host.shared.apply({ a: 0, t: '@SL', d: { a: 'P', k: 'games', n: 0, p: 'answer', v: 6 } })
    host.shared.apply({ a: 0, t: '@SL', d: { a: 'P', k: 'games', n: 0, p: 'showAnswer', v: true } })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    databaseRuns.mockRejectedValueOnce(new Error('archive unavailable')).mockResolvedValue({ success: true })

    await expect(room.publishState()).resolves.toBeUndefined()
    expect(room.broadcast).toHaveBeenCalledOnce()
    expect(room.lastQuestionFingerprint).toBeNull()
    expect(warning).toHaveBeenCalledWith('Failed to archive an observed question')

    await room.publishState()
    expect(databaseRuns).toHaveBeenCalledTimes(2)
    expect(room.lastQuestionFingerprint).not.toBeNull()
    warning.mockRestore()
  })

  it('clears request state and rejects immediately when socket.send throws', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', { OPEN: 1 })
    const socket = new PartySocket('party', async () => 'session', vi.fn())
    const close = vi.fn()
    const internals = socket as unknown as {
      socket: { readyState: number, send: () => never, close: ReturnType<typeof vi.fn> }
      pending: unknown
      synchronized: boolean
    }
    internals.socket = { readyState: 1, send: () => { throw new Error('send failed') }, close }
    internals.synchronized = true

    await expect(socket.request(7, 'answer', 1)).rejects.toThrow('Party request answer could not be sent')
    expect(internals.pending).toBeNull()
    expect(close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('keeps TTMC questions and answers private until the round is finished', async () => {
    const { room, host, guest } = createHarness(null)
    room.match.game_mode = 'ttmc'
    room.match.rounds = 10
    for (const party of [host, guest]) {
      party.shared.apply({ a: 0, t: '@SL', d: { a: 'C', k: 'rounds', v: [{ id: 12, gameName: 'ttmc-round', state: 'running', played: [], total: 10 }] } })
      party.shared.apply({ a: 12, t: '@SL', d: { a: 'C', k: 'scores', v: [] } })
    }
    host.request.mockImplementation(async (_app, type, data) => {
      if (type === 'start') {
        for (const party of [host, guest]) party.shared.apply({ a: 12, t: '@SL', d: { a: 'A', k: 'scores', v: { id: 101, difficulty: data, success: null, points: 0 } } })
        return { question: 'Vrai ?', answers: { selected: 'bool', answer: true } }
      }
      return { success: true }
    })
    guest.request.mockImplementation(async (_app, type, data) => {
      if (type === 'start') {
        for (const party of [host, guest]) party.shared.apply({ a: 12, t: '@SL', d: { a: 'A', k: 'scores', v: { id: 202, difficulty: data, success: null, points: 0 } } })
        return { question: 'Choix ?', answers: { selected: 'qcm', totalCorrectAnswers: 'all', answers: [{ text: 'A', correct: true }, { text: 'B', correct: false }] } }
      }
      return { success: true }
    })

    await room.handleCommand({ type: 'start-ttmc-question', roundId: 12, side: 'a', difficulty: 9 })
    await room.handleCommand({ type: 'start-ttmc-question', roundId: 12, side: 'b', difficulty: 0 })
    expect(host.request).toHaveBeenCalledWith(12, 'start', 9)
    expect(guest.request).toHaveBeenCalledWith(12, 'start', 0)
    const active = room.snapshot().game as { teams: Record<'a' | 'b', { difficulty: number, question: unknown, success: unknown, points: unknown, officialAnswer: unknown }> }
    expect(active.teams.a).toMatchObject({ difficulty: 10, success: null, points: null, officialAnswer: null })
    expect(active.teams.b).toMatchObject({ difficulty: 1, success: null, points: null, officialAnswer: null })
    expect(JSON.stringify(active)).not.toContain('correct')

    await room.handleCommand({ type: 'ttmc-answers', roundId: 12, answers: { a: true, b: [0] } })
    expect(host.request).toHaveBeenCalledWith(12, 'answer', true)
    expect(guest.request).toHaveBeenCalledWith(12, 'answer', [0])
    host.shared.apply({ a: 12, t: '@SL', d: { a: 'P', k: 'scores', n: 0, p: 'success', v: true } })
    host.shared.apply({ a: 12, t: '@SL', d: { a: 'P', k: 'scores', n: 0, p: 'points', v: 10 } })
    host.shared.apply({ a: 0, t: '@SL', d: { a: 'P', k: 'rounds', n: 0, p: 'state', v: 'finished' } })
    const finished = room.snapshot().game as { teams: Record<'a' | 'b', { success: unknown, points: unknown, officialAnswer: unknown }> }
    expect(finished.teams.a).toMatchObject({ success: true, points: 10, officialAnswer: 'Yes' })
  })

  it('validates TTMC answer shape and refuses cross-mode commands', async () => {
    const { room } = createHarness(7)
    await expect(room.handleCommand({ type: 'start-ttmc-question', roundId: 7, side: 'a', difficulty: 0 }))
      .rejects.toMatchObject({ code: 'unsupported-action' })
  })

  it('validates TTMC number, one-word, and word answers and sends their normalized wire values', async () => {
    const number = createHarness(null)
    activateTtmcRound(number.room, number.host, number.guest)
    addTtmcScore(number.host, number.guest, 101, 4)
    number.storage.set('ttmc:question:12:101', {
      raw: { question: 'How many?', answers: { selected: 'number', correct: 42, min: 0, max: 100, tolerance: 0.5 } },
      public: { type: 'number', prompt: 'How many?', min: 0, max: 100, step: 0.1 },
    })
    number.host.request.mockResolvedValue({ success: true })
    await expect(number.room.handleCommand({ type: 'ttmc-answers', roundId: 12, answers: { a: 42.5 } })).resolves.toEqual(['accepted'])
    await expect(number.room.handleCommand({ type: 'ttmc-answers', roundId: 12, answers: { a: 42.55 } }))
      .rejects.toMatchObject({ code: 'invalid-answers' })
    expect(number.host.request).toHaveBeenCalledWith(12, 'answer', 42.5)

    const decimalNumber = createHarness(null)
    activateTtmcRound(decimalNumber.room, decimalNumber.host, decimalNumber.guest)
    addTtmcScore(decimalNumber.host, decimalNumber.guest, 101, 4)
    decimalNumber.storage.set('ttmc:question:12:101', {
      raw: { question: 'How precise?', answers: { selected: 'number', correct: 4.2, min: 0, max: 10, tolerance: 0.05 } },
      public: { type: 'number', prompt: 'How precise?', min: 0, max: 10, step: 0.01 },
    })
    decimalNumber.host.request.mockResolvedValue({ success: true })
    await expect(decimalNumber.room.handleCommand({ type: 'ttmc-answers', roundId: 12, answers: { a: 4.25 } })).resolves.toEqual(['accepted'])
    expect(decimalNumber.host.request).toHaveBeenCalledWith(12, 'answer', 4.25)

    const oneword = createHarness(null)
    activateTtmcRound(oneword.room, oneword.host, oneword.guest)
    addTtmcScore(oneword.host, oneword.guest, 101, 4)
    oneword.storage.set('ttmc:question:12:101', {
      raw: { question: 'Name it', answers: { selected: 'oneword', theWord: 'Paris' } },
      public: { type: 'oneword', prompt: 'Name it' },
    })
    oneword.host.request.mockResolvedValue({ success: true })
    await expect(oneword.room.handleCommand({ type: 'ttmc-answers', roundId: 12, answers: { a: '  PARIS  ' } })).resolves.toEqual(['accepted'])
    await expect(oneword.room.handleCommand({ type: 'ttmc-answers', roundId: 12, answers: { a: '   ' } }))
      .rejects.toMatchObject({ code: 'invalid-answers' })
    expect(oneword.host.request).toHaveBeenCalledWith(12, 'answer', 'paris')

    const words = createHarness(null)
    activateTtmcRound(words.room, words.host, words.guest)
    addTtmcScore(words.host, words.guest, 101, 4)
    words.storage.set('ttmc:question:12:101', {
      raw: { question: 'Complete it', answers: { selected: 'words', correctSentence: 'blue sky', wrongWords: 'green' } },
      public: { type: 'words', prompt: 'Complete it', candidates: ['blue', 'sky', 'green'], answerWordCount: 2 },
    })
    words.host.request.mockResolvedValue({ success: true })
    await expect(words.room.handleCommand({ type: 'ttmc-answers', roundId: 12, answers: { a: ['sky', 'blue'] } })).resolves.toEqual(['accepted'])
    await expect(words.room.handleCommand({ type: 'ttmc-answers', roundId: 12, answers: { a: ['blue'] } }))
      .rejects.toMatchObject({ code: 'invalid-answers' })
    expect(words.host.request).toHaveBeenCalledWith(12, 'answer', ['sky', 'blue'])
  })

  it('recovers a lost TTMC start response through synchronized score and get-question without another start', async () => {
    const { room, host, guest, storage } = createHarness(null)
    activateTtmcRound(room, host, guest)
    host.request.mockImplementation(async (_app, type) => {
      if (type === 'start') {
        host.shared.apply({ a: 12, t: '@SL', d: { a: 'A', k: 'scores', v: { id: 101, difficulty: 4 } } })
        throw new Error('response lost')
      }
      return { question: 'Recovered?', answers: { selected: 'oneword', theWord: 'secret' } }
    })

    await expect(room.handleCommand({ type: 'start-ttmc-question', roundId: 12, side: 'a', difficulty: 4 })).resolves.toBe('accepted')
    expect(host.request).toHaveBeenCalledWith(12, 'start', 4)
    expect(host.request).toHaveBeenCalledWith(12, 'get-question', undefined)
    expect(host.request.mock.calls.filter(([, type]) => type === 'start')).toHaveLength(1)
    expect(storage.get('ttmc:start:12:101')).toEqual({ difficulty: 4 })
    expect(JSON.stringify(room.snapshot())).not.toContain('secret')
  })

  it('reconciles a pending TTMC answer from played and score state without resubmitting it', async () => {
    const { room, host, guest, storage } = createHarness(null)
    activateTtmcRound(room, host, guest, { id: 12, gameName: 'ttmc-round', state: 'running', played: [101], total: 10 })
    host.shared.apply({ a: 12, t: '@SL', d: { a: 'A', k: 'scores', v: { id: 101, difficulty: 4, success: true, points: 5 } } })
    storage.set('ttmc:question:12:101', {
      raw: { question: 'Name it', answers: { selected: 'oneword', theWord: 'secret' } },
      public: { type: 'oneword', prompt: 'Name it' },
    })
    storage.set('ttmc:answer:12:101', { status: 'pending', value: 'guess' })

    await expect(room.handleCommand({ type: 'ttmc-answers', roundId: 12, answers: { a: ' GUESS ' } })).resolves.toEqual(['already-submitted'])
    expect(host.request).not.toHaveBeenCalled()
    expect(storage.get('ttmc:answer:12:101')).toEqual({ status: 'accepted', value: 'guess' })
    expect(JSON.stringify(room.snapshot())).not.toContain('guess')
    expect(JSON.stringify(room.snapshot())).not.toContain('secret')
  })

  it('starts the next production-style TTMC round once and reconciles its retry without another start-round', async () => {
    const { room, host, guest, storage } = createHarness(null)
    activateTtmcRound(room, host, guest, { id: 12, gameName: 'ttmc-round', state: 'finished', played: [101, 202], total: 10 })
    host.request.mockImplementation(async (_app, type) => {
      if (type === 'start-round') {
        for (const party of [host, guest]) party.shared.apply({
          a: 0, t: '@SL', d: { a: 'A', k: 'rounds', v: { id: 13, gameName: 'ttmc-round', state: 'running', played: [], total: 10 } },
        })
      }
      return 'success'
    })

    await expect(room.handleCommand({ type: 'next-ttmc-round', roundId: 12 })).resolves.toBe('success')
    for (const party of [host, guest]) party.shared.apply({
      a: 0, t: '@SL', d: { a: 'P', k: 'rounds', n: 1, p: 'state', v: 'finished' },
    })
    await expect(room.handleCommand({ type: 'next-ttmc-round', roundId: 12 })).resolves.toBe('already-started')
    expect(host.request.mock.calls.filter(([, type]) => type === 'start-round')).toHaveLength(1)
    expect(storage.get('ttmc:next:12')).toEqual({ beforeRoundIds: [12] })
  })

  it('starts the first TTMC round once while the party is waiting', async () => {
    const { room, host, guest, storage } = createHarness(null)
    room.match.game_mode = 'ttmc'
    room.match.rounds = 10
    for (const party of [host, guest]) {
      party.shared.apply({ a: 0, t: '@SL', d: { a: 'C', k: 'rounds', v: [] } })
      party.shared.apply({ a: 0, t: '@SO', d: { a: 'M', k: 'party', n: 'state', v: 'waiting' } })
    }
    host.request.mockImplementation(async (_app, type) => {
      if (type === 'start-round') {
        for (const party of [host, guest]) {
          party.shared.apply({ a: 0, t: '@SO', d: { a: 'M', k: 'party', n: 'state', v: 'running' } })
          party.shared.apply({
            a: 0, t: '@SL', d: { a: 'A', k: 'rounds', v: { id: 1, gameName: 'ttmc-round', state: 'running', played: [], total: 10 } },
          })
        }
      }
      return 'success'
    })

    await expect(room.handleCommand({ type: 'start-ttmc-round' })).resolves.toBe('success')
    await expect(room.handleCommand({ type: 'start-ttmc-round' })).resolves.toBe('already-started')
    expect(host.request.mock.calls.filter(([, type]) => type === 'start-round')).toHaveLength(1)
    expect(storage.get('ttmc:next:initial')).toEqual({ beforeRoundIds: [] })
  })

  it('keeps non-bootstrap TTMC commands blocked while the party is waiting', async () => {
    const { room, host, guest } = createHarness(null)
    activateTtmcRound(room, host, guest)
    host.shared.apply({ a: 0, t: '@SO', d: { a: 'M', k: 'party', n: 'state', v: 'waiting' } })

    await expect(room.handleCommand({ type: 'start-ttmc-question', roundId: 12, side: 'a', difficulty: 0 }))
      .rejects.toMatchObject({ code: 'party-not-running' })
    expect(host.request).not.toHaveBeenCalled()
  })

  it('exposes cumulative TTMC scores only from a finished current round or finished party', () => {
    const { room, host, guest } = createHarness(null)
    activateTtmcRound(room, host, guest)
    for (const party of [host, guest]) {
      party.shared.apply({ a: 0, t: '@SL', d: { a: 'P', k: 'players', n: 0, p: 'score', v: 5 } })
    }
    expect((room.snapshot().players as Array<{ score: number | null }>)[0].score).toBeNull()

    for (const party of [host, guest]) {
      party.shared.apply({ a: 0, t: '@SL', d: { a: 'P', k: 'rounds', n: 0, p: 'state', v: 'finished' } })
    }
    expect((room.snapshot().players as Array<{ score: number | null }>)[0].score).toBe(5)

    const unknown = createHarness(null)
    activateTtmcRound(unknown.room, unknown.host, unknown.guest, {
      id: 12, gameName: 'ttmc-round', state: 'unknown', played: [], total: 10,
    })
    unknown.host.shared.apply({ a: 0, t: '@SL', d: { a: 'P', k: 'players', n: 0, p: 'score', v: 7 } })
    expect((unknown.room.snapshot().players as Array<{ score: number | null }>)[0].score).toBeNull()

    const multiple = createHarness(null)
    activateTtmcRound(multiple.room, multiple.host, multiple.guest)
    multiple.host.shared.apply({
      a: 0, t: '@SL', d: { a: 'A', k: 'rounds', v: { id: 13, gameName: 'ttmc-round', state: 'running', played: [], total: 10 } },
    })
    multiple.host.shared.apply({ a: 0, t: '@SL', d: { a: 'P', k: 'players', n: 0, p: 'score', v: 9 } })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((multiple.room.snapshot().players as Array<{ score: number | null }>)[0].score).toBeNull()
    error.mockRestore()

    const duplicate = createHarness(null)
    activateTtmcRound(duplicate.room, duplicate.host, duplicate.guest, {
      id: 12, gameName: 'ttmc-round', state: 'finished', played: [], total: 10,
    })
    duplicate.host.shared.apply({
      a: 0, t: '@SL', d: { a: 'A', k: 'rounds', v: { id: 12, gameName: 'ttmc-round', state: 'finished', played: [], total: 10 } },
    })
    duplicate.host.shared.apply({ a: 0, t: '@SL', d: { a: 'P', k: 'players', n: 0, p: 'score', v: 10 } })
    const duplicateError = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((duplicate.room.snapshot().players as Array<{ score: number | null }>)[0].score).toBeNull()
    duplicateError.mockRestore()

    const finishedParty = createHarness(null)
    finishedParty.room.match.game_mode = 'ttmc'
    finishedParty.host.shared.apply({ a: 0, t: '@SO', d: { a: 'M', k: 'party', n: 'state', v: 'finished' } })
    finishedParty.host.shared.apply({ a: 0, t: '@SL', d: { a: 'P', k: 'players', n: 0, p: 'score', v: 11 } })
    expect((finishedParty.room.snapshot().players as Array<{ score: number | null }>)[0].score).toBe(11)
  })

  it('validates both TTMC answers before sending and waits for every started submission to settle', async () => {
    const malformed = createHarness(null)
    activateTtmcRound(malformed.room, malformed.host, malformed.guest)
    addTtmcScore(malformed.host, malformed.guest, 101, 4)
    addTtmcScore(malformed.host, malformed.guest, 202, 4)
    for (const [playerId, prompt] of [[101, 'A?'], [202, 'B?']] as const) {
      malformed.storage.set(`ttmc:question:12:${playerId}`, {
        raw: { question: prompt, answers: { selected: 'bool', answer: true } },
        public: { type: 'bool', prompt },
      })
    }
    await expect(malformed.room.handleCommand({ type: 'ttmc-answers', roundId: 12, answers: { a: true, b: 'invalid' } }))
      .rejects.toMatchObject({ code: 'invalid-answers' })
    expect(malformed.host.request).not.toHaveBeenCalled()
    expect(malformed.guest.request).not.toHaveBeenCalled()

    const concurrent = createHarness(null)
    activateTtmcRound(concurrent.room, concurrent.host, concurrent.guest)
    addTtmcScore(concurrent.host, concurrent.guest, 101, 4)
    addTtmcScore(concurrent.host, concurrent.guest, 202, 4)
    for (const [playerId, prompt] of [[101, 'A?'], [202, 'B?']] as const) {
      concurrent.storage.set(`ttmc:question:12:${playerId}`, {
        raw: { question: prompt, answers: { selected: 'bool', answer: true } },
        public: { type: 'bool', prompt },
      })
    }
    const guestResult = deferred<unknown>()
    concurrent.host.request.mockRejectedValue(new Error('host response lost'))
    concurrent.guest.request.mockReturnValue(guestResult.promise)
    let settled = false
    const command = concurrent.room.handleCommand({ type: 'ttmc-answers', roundId: 12, answers: { a: true, b: false } })
      .finally(() => { settled = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    guestResult.resolve({ success: true })
    await expect(command).rejects.toMatchObject({ code: 'answer-outcome-unknown' })
    expect(concurrent.guest.request).toHaveBeenCalledWith(12, 'answer', false)
  })

  it('rejects TTMC advances with another running round and TTMC commands in Proximo mode', async () => {
    const { room, host, guest } = createHarness(null)
    activateTtmcRound(room, host, guest)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const party of [host, guest]) party.shared.apply({
      a: 0, t: '@SL', d: { a: 'A', k: 'rounds', v: { id: 13, gameName: 'ttmc-round', state: 'running', played: [], total: 10 } },
    })
    expect(room.snapshot().game).toBeNull()
    expect(error).toHaveBeenCalledWith('TTMC synchronized multiple running rounds')
    await expect(room.handleCommand({ type: 'next-ttmc-round', roundId: 12 })).rejects.toMatchObject({ code: 'round-not-current' })
    expect(host.request).not.toHaveBeenCalled()
    error.mockRestore()

    const proximo = createHarness(7)
    await expect(proximo.room.handleCommand({ type: 'next-ttmc-round', roundId: 7 }))
      .rejects.toMatchObject({ code: 'unsupported-action' })
  })
})
