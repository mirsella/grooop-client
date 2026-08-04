import { expect, test, type Page, type Route } from '@playwright/test'

const accounts = [
  { id: 'account-a', email: 'm***@protonmail.com', userId: 34869, grooopies: 1500, status: 'active' },
  { id: 'account-b', email: 'm***1@gmail.com', userId: 34870, grooopies: 900, status: 'active' },
]

const presets = [
  {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'The Regulars',
    roster: ['Ada', 'Grace', 'Katherine'],
    createdAt: '2026-07-25T08:00:00.000Z',
    updatedAt: '2026-07-26T08:00:00.000Z',
  },
]

const observedQuestions = [
  {
    content: '300',
    category: 'Cinema',
    question: 'How many roads must a player walk down?',
    answer: '42',
    firstSeenAt: '2026-07-26T08:15:00.000Z',
  },
]

const match = {
  id: '11111111-1111-4111-8111-111111111111',
  status: 'waiting',
  teamA: { name: 'Team A', roster: ['Player one', 'Player two'], accountId: 'account-a' },
  teamB: { name: 'Team B', roster: ['Player three', 'Player four'], accountId: 'account-b' },
  gameMode: 'proximo' as const,
  contentSlug: '300',
  ttmcContentSlugs: null,
  durationMinutes: 30,
  rounds: null,
  cost: 100,
  error: null,
  createdAt: '2026-07-26T08:00:00.000Z',
  finishedAt: null as string | null,
}

type RequestBody = Record<string, unknown>
type LiveCommand = {
  type: string
  actionId: string
  gameId?: number
  currentRound?: number
  roundId?: number
  side?: 'a' | 'b'
  difficulty?: number
  answers?: Partial<Record<'a' | 'b', boolean | number | string | Array<string | number>>>
}

type MockApiState = {
  accounts: typeof accounts
  presets: typeof presets
  matches: Array<typeof match>
  questions: typeof observedQuestions
  createFailuresRemaining: number
  createDelay: number
  costChangesRemaining: number
  quoteRequests: RequestBody[]
  quoteFailuresRemaining: number
  createdMatchStatus: string
  createBodies: RequestBody[]
  presetCreates: RequestBody[]
  reauthenticationRequests: Array<{ path: string; body: string | null }>
  cacheProbeRequests: number
  unexpectedRequests: string[]
  allowedBrowserErrors: RegExp[]
  refreshUnauthorized: boolean
  matchGetDelays: number[]
  matchFailuresRemaining: number
  questionFailure: boolean
  ttmcCatalogs: Record<string, { owned: boolean; contents: Array<{ slug: string; title: string }>; rounds: { min: number; max: number; default: number; step: number } }>
  ttmcCatalogDelays: Record<string, number>
  ttmcCatalogFailuresRemaining: Record<string, number>
}

const apiStates = new WeakMap<Page, MockApiState>()
const browserErrors = new WeakMap<Page, string[]>()

async function fulfill(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  })
}

async function mockApi(page: Page): Promise<MockApiState> {
  const state: MockApiState = {
    accounts: structuredClone(accounts),
    presets: structuredClone(presets),
    matches: [],
    questions: [],
    createFailuresRemaining: 0,
    createDelay: 0,
    costChangesRemaining: 0,
    quoteRequests: [],
    quoteFailuresRemaining: 0,
    createdMatchStatus: 'waiting',
    createBodies: [],
    presetCreates: [],
    reauthenticationRequests: [],
    cacheProbeRequests: 0,
    unexpectedRequests: [],
    allowedBrowserErrors: [],
    refreshUnauthorized: false,
    matchGetDelays: [],
    matchFailuresRemaining: 0,
    questionFailure: false,
    ttmcCatalogs: Object.fromEntries(accounts.map((account) => [account.id, { owned: true, contents: [
      { slug: 'included', title: 'Included' },
      { slug: 'ttmc-musique', title: 'TTMC Musique' },
      { slug: 'ttmc-bonnebouffe', title: 'TTMC Bonne Bouffe' },
    ], rounds: { min: 2, max: 10, default: 5, step: 1 } }])),
    ttmcCatalogDelays: {},
    ttmcCatalogFailuresRemaining: {},
  }

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    if (url.pathname === '/api/accounts' && method === 'GET') return fulfill(route, { accounts: state.accounts })
    if (/^\/api\/accounts\/[^/]+\/shop$/.test(url.pathname) && method === 'GET') {
      const accountId = url.pathname.split('/')[3]
      const catalog = structuredClone(state.ttmcCatalogs[accountId])
      const delay = state.ttmcCatalogDelays[accountId] ?? 0
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
      if ((state.ttmcCatalogFailuresRemaining[accountId] ?? 0) > 0) {
        state.ttmcCatalogFailuresRemaining[accountId] -= 1
        return fulfill(route, { error: 'ttmc-catalog-failed', message: 'Could not load TTMC packs.' }, 503)
      }
      return fulfill(route, catalog ?? { owned: false, contents: [], rounds: { min: 2, max: 10, default: 5, step: 1 } })
    }
    if (url.pathname === '/api/team-presets' && method === 'GET') return fulfill(route, { presets: state.presets })
    if (url.pathname === '/api/matches/quote' && request.method() === 'POST') {
      state.quoteRequests.push(request.postDataJSON() as RequestBody)
      if (state.quoteFailuresRemaining > 0) {
        state.quoteFailuresRemaining -= 1
        return fulfill(route, { error: 'quote-failed', message: 'Could not price this match.' }, 503)
      }
      return fulfill(route, { quote: {
        cost: 100,
        userCanSpend: true,
        hostBalance: 1500,
        guestBalance: 900,
      } })
    }
    if (url.pathname === '/api/matches' && method === 'POST') {
      const setup = request.postDataJSON() as RequestBody
      state.createBodies.push(setup)
      if (state.createDelay) await new Promise((resolve) => setTimeout(resolve, state.createDelay))
      if (state.createFailuresRemaining > 0) {
        state.createFailuresRemaining -= 1
        return fulfill(route, { error: 'temporary-create-failure', message: 'Create failed. Try again.' }, 503)
      }
      if (state.costChangesRemaining > 0) {
        state.costChangesRemaining -= 1
        return fulfill(route, { error: 'party-cost-changed', message: 'Party cost changed; review the new quote' }, 409)
      }
      const created = {
        ...match,
        status: state.createdMatchStatus,
        gameMode: setup.gameMode,
        teamA: { ...(setup.teamA as object), accountId: setup.teamAAccountId },
        teamB: { ...(setup.teamB as object), accountId: setup.teamBAccountId },
        contentSlug: setup.gameMode === 'proximo' ? setup.contentSlug : null,
        ttmcContentSlugs: setup.gameMode === 'ttmc' ? setup.ttmcContentSlugs : null,
        durationMinutes: setup.gameMode === 'proximo' ? setup.durationMinutes : null,
        rounds: setup.gameMode === 'ttmc' ? setup.rounds : null,
      }
      state.matches = [created]
      return fulfill(route, { match: created }, 201)
    }
    if (url.pathname === '/api/matches' && method === 'GET') {
      const snapshot = structuredClone(state.matches)
      const delay = state.matchGetDelays.shift() ?? 0
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
      if (state.matchFailuresRemaining > 0) {
        state.matchFailuresRemaining -= 1
        return fulfill(route, { error: 'match-list-failed', message: 'Active match check failed upstream.' }, 503)
      }
      return fulfill(route, { matches: snapshot })
    }
    const resume = url.pathname.match(/^\/api\/matches\/([^/]+)\/resume$/)
    if (resume && method === 'POST') {
      const existing = state.matches.find((item) => item.id === resume[1])
      if (!existing) return fulfill(route, { error: 'match-not-found' }, 404)
      existing.status = 'waiting'
      existing.error = null
      return fulfill(route, { match: existing })
    }
    const cancel = url.pathname.match(/^\/api\/matches\/([^/]+)\/cancel$/)
    if (cancel && method === 'POST') {
      const existing = state.matches.find((item) => item.id === cancel[1])
      if (!existing) return fulfill(route, { error: 'match-not-found' }, 404)
      existing.status = 'cancelled'
      existing.finishedAt = '2026-07-26T10:00:00.000Z'
      return fulfill(route, { match: existing })
    }
    if (url.pathname === '/api/questions' && method === 'GET') {
      if (state.questionFailure) return fulfill(route, { error: 'question-list-failed', message: 'Could not load questions.' }, 503)
      return fulfill(route, { questions: state.questions })
    }
    if (url.pathname === '/api/team-presets' && method === 'POST') {
      const input = request.postDataJSON() as RequestBody
      state.presetCreates.push(input)
      const preset = {
        id: '33333333-3333-4333-8333-333333333333',
        name: String(input.name),
        roster: input.roster as string[],
        createdAt: '2026-07-26T09:00:00.000Z',
        updatedAt: '2026-07-26T09:00:00.000Z',
      }
      state.presets.unshift(preset)
      return fulfill(route, { preset }, 201)
    }
    const reauthentication = url.pathname.match(/^\/api\/accounts\/([^/]+)\/reauthenticate$/)
    if (reauthentication && method === 'POST') {
      state.reauthenticationRequests.push({ path: url.pathname, body: request.postData() })
      return fulfill(route, { challenge: {
        id: '44444444-4444-4444-8444-444444444444',
        email: 're********@example.com',
      } }, 201)
    }
    const refresh = url.pathname.match(/^\/api\/accounts\/([^/]+)\/refresh$/)
    if (refresh && method === 'POST') {
      if (state.refreshUnauthorized) {
        state.accounts = state.accounts.map((account) => account.id === refresh[1]
          ? { ...account, status: 'reauth-required' }
          : account)
        return fulfill(route, { error: 'grooop-unauthorized', message: 'Grooop rejected this session' }, 401)
      }
      const account = state.accounts.find((item) => item.id === refresh[1])
      return account ? fulfill(route, { account }) : fulfill(route, { error: 'account-not-found' }, 404)
    }
    if (url.pathname === '/api/cache-probe' && method === 'GET') {
      state.cacheProbeRequests += 1
      return fulfill(route, { request: state.cacheProbeRequests })
    }
    state.unexpectedRequests.push(`${method} ${url.pathname}`)
    return fulfill(route, { error: 'unexpected-test-request' }, 501)
  })
  return state
}

async function mockLiveSocket(page: Page) {
  await page.addInitScript(({ matchId }) => {
    const commands: LiveCommand[] = []
    const submittedAnswers: Partial<Record<'a' | 'b', number>> = {}
    const sockets = new Set<TestWebSocket>()
    let gameSequence = 0
    let failedConnectionsRemaining = 0
    let malformedNextActionResult = false
    let rejectNextCommandType: string | null = null
    const nativeSetTimeout = globalThis.setTimeout.bind(globalThis)
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => nativeSetTimeout(handler, timeout && timeout >= 1_000 ? 5 : timeout, ...args)) as typeof setTimeout
    const teams = {
      a: { name: 'Team A', roster: ['Player one', 'Player two'], accountId: 'account-a' },
      b: { name: 'Team B', roster: ['Player three', 'Player four'], accountId: 'account-b' },
    }
    const live = {
      id: matchId,
      status: 'waiting',
      party: { state: 'running', playerCount: 2 },
      players: [
        { id: 34869, isConnected: true, isGameMaster: true, score: 0 as number | null },
        { id: 34870, isConnected: true, isGameMaster: false, score: 0 as number | null },
      ],
      teams,
      contentSlug: '300',
      gameMode: 'proximo',
      game: null as null | Record<string, unknown>,
      connected: true,
    }
    const ttmcQuestions = {
      a: { type: 'bool', prompt: 'Is the secret switch on?' },
      b: { type: 'qcm', prompt: 'Choose the two bright moons.', options: ['Io', 'Europa', 'Titan'], selectionCount: 2 },
    }

    function setTtmcState(aQuestion = ttmcQuestions.a, bQuestion = ttmcQuestions.b, questionsStarted = false) {
      live.gameMode = 'ttmc'
      live.party.state = 'running'
      live.players = live.players.map((player) => ({ ...player, score: null }))
      live.game = {
        mode: 'ttmc', id: 777, roundNumber: 1, totalRounds: 7, state: 'running', category: 'Space', title: 'Twin topics',
        teams: {
          a: { difficulty: questionsStarted ? 1 : null, submitted: false, success: null, points: null, question: questionsStarted ? aQuestion : null, officialAnswer: null },
          b: { difficulty: questionsStarted ? 1 : null, submitted: false, success: null, points: null, question: questionsStarted ? bQuestion : null, officialAnswer: null },
        },
      }
      sockets.forEach((socket) => socket.emit({ type: 'state', match: live }))
    }

    class TestWebSocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSING = 2
      static readonly CLOSED = 3
      readonly url: string
      readyState = TestWebSocket.CONNECTING
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onclose: ((event: CloseEvent) => void) | null = null

      constructor(url: string | URL) {
        this.url = String(url)
        sockets.add(this)
        setTimeout(() => {
          if (failedConnectionsRemaining > 0) {
            failedConnectionsRemaining -= 1
            this.serverDisconnect()
            return
          }
          this.readyState = TestWebSocket.OPEN
          this.onopen?.(new Event('open'))
          this.emit({ type: 'state', match: live })
        }, 0)
      }

      send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (data === 'ping') {
          this.emit({ type: 'pong' })
          return
        }
        if (typeof data !== 'string') return
        const command = JSON.parse(data) as LiveCommand
        commands.push(command)
        if (rejectNextCommandType === command.type) {
          rejectNextCommandType = null
          setTimeout(() => this.emit({ type: 'action-error', actionId: command.actionId, message: 'Answer rejected for this test.' }), 0)
          return
        }
        if (command.type === 'start-proximo' || command.type === 'next-proximo') {
          gameSequence += 1
          delete submittedAnswers.a
          delete submittedAnswers.b
          live.game = {
            id: 455 + gameSequence,
            state: 'tutorial',
            currentRound: -1,
            questionDurationSeconds: 30,
            questionDeadlineAt: null,
            category: null,
            question: null,
            showAnswer: false,
            answer: null,
            scores: [
              { id: 34869, isReady: false, submitted: false, answer: null, delta: null },
              { id: 34870, isReady: false, submitted: false, answer: null, delta: null },
            ],
          }
        }
        if (command.type === 'ready' && live.game) {
          const game = live.game as { scores: Array<Record<string, unknown>> }
          game.scores = game.scores.map((score) => ({ ...score, isReady: true }))
          Object.assign(live.game, {
            state: 'playing',
            currentRound: 0,
            category: gameSequence === 1 ? 'Cinema' : 'Science',
            question: gameSequence === 1 ? 'How many roads must a player walk down?' : 'How many planets orbit the Sun?',
            questionDeadlineAt: Date.now() + 30_000,
          })
        }
        if (command.type === 'answers' && live.game && command.answers) {
          const game = live.game as { scores: Array<Record<string, unknown>> }
          for (const side of ['a', 'b'] as const) {
            const answer = command.answers[side]
            if (answer === undefined) continue
            submittedAnswers[side] = answer
            const index = side === 'a' ? 0 : 1
            game.scores[index] = { ...game.scores[index], submitted: true, answer }
          }
        }
        if (command.type === 'start-ttmc-round' && live.gameMode === 'ttmc' && !live.game) setTtmcState()
        if (command.type === 'start-ttmc-question' && live.gameMode === 'ttmc' && live.game && command.side && typeof command.difficulty === 'number') {
          const game = live.game as { teams: Record<'a' | 'b', Record<string, unknown>> }
          const team = game.teams[command.side]
          game.teams[command.side] = { ...team, difficulty: command.difficulty + 1, question: ttmcQuestions[command.side] }
        }
        if (command.type === 'ttmc-answers' && live.gameMode === 'ttmc' && live.game && command.answers) {
          const game = live.game as { teams: Record<'a' | 'b', Record<string, unknown>> }
          for (const side of ['a', 'b'] as const) {
            if (command.answers[side] !== undefined) game.teams[side] = { ...game.teams[side], submitted: true }
          }
        }
        if (command.type === 'finish') live.status = 'finished'
        const result = command.type === 'ready' || command.type === 'answers' ? ['ok', 'ok'] : 'success'
        this.emit({ type: 'state', match: live })
        this.emit({ type: 'action-result', actionId: malformedNextActionResult ? 'wrong-action-id' : command.actionId, result })
        malformedNextActionResult = false
      }

      close() {
        if (this.readyState === TestWebSocket.CLOSED) return
        this.readyState = TestWebSocket.CLOSED
        sockets.delete(this)
        setTimeout(() => this.onclose?.(new CloseEvent('close')), 0)
      }

      serverDisconnect() {
        if (this.readyState === TestWebSocket.CLOSED) return
        this.readyState = TestWebSocket.CLOSED
        sockets.delete(this)
        setTimeout(() => this.onclose?.(new CloseEvent('close')), 0)
      }

      synchronizeAnswer(side: 'a' | 'b', answer: number) {
        if (!live.game) return
        const game = live.game as { scores: Array<Record<string, unknown>> }
        const index = side === 'a' ? 0 : 1
        submittedAnswers[side] = answer
        game.scores[index] = { ...game.scores[index], submitted: true, answer }
        this.emit({ type: 'state', match: live })
      }

      expireQuestion() {
        if (!live.game) return
        live.game.questionDeadlineAt = Date.now() - 1_000
        this.emit({ type: 'state', match: live })
      }

      emitMalformedIdentity() {
        if (!live.game) return
        this.emit({ type: 'state', match: { ...live, game: { ...live.game, id: null } } })
      }

      revealAnswers() {
        if (!live.game) return
        const game = live.game as { scores: Array<Record<string, unknown>> }
        Object.assign(live.game, {
          state: 'revealed', showAnswer: true, answer: 42, questionDeadlineAt: null,
          scores: game.scores.map((score, scoreIndex) => ({
            ...score,
            answer: scoreIndex === 0 ? submittedAnswers.a ?? null : submittedAnswers.b ?? null,
            delta: scoreIndex === 0 ? 2 : 0,
          })),
        })
        this.emit({ type: 'state', match: live })
      }

      private emit(value: unknown, delay = 0) {
        const data = JSON.stringify(value)
        setTimeout(() => this.onmessage?.(new MessageEvent('message', { data })), delay)
      }
    }

    Object.assign(globalThis, {
      __e2eSocketCommands: commands,
      __e2eRevealAnswers: () => sockets.forEach((socket) => socket.revealAnswers()),
      __e2eSetTtmcWaiting: () => {
        live.gameMode = 'ttmc'
        live.party.state = 'waiting'
        live.game = null
        sockets.forEach((socket) => socket.emit({ type: 'state', match: live }))
      },
      __e2eSetTtmcState: (aQuestion?: Record<string, unknown>, bQuestion?: Record<string, unknown>, questionsStarted?: boolean) => setTtmcState(aQuestion, bQuestion, questionsStarted),
      __e2eRejectNextCommand: (type: string) => { rejectNextCommandType = type },
      __e2eFinishTtmcRound: () => {
        if (live.gameMode !== 'ttmc' || !live.game) return
        const game = live.game as { state: string; teams: Record<'a' | 'b', Record<string, unknown>> }
        game.state = 'finished'
        game.teams.a = { ...game.teams.a, success: true, points: 3, officialAnswer: 'Yes' }
        game.teams.b = { ...game.teams.b, success: false, points: 0, officialAnswer: ['Io', 'Europa'] }
        sockets.forEach((socket) => socket.emit({ type: 'state', match: live }))
      },
      __e2eEmitEarlyTtmcResult: () => {
        if (live.gameMode !== 'ttmc' || !live.game) return
        const game = structuredClone(live.game) as { teams: Record<'a' | 'b', Record<string, unknown>> }
        game.teams.a = { ...game.teams.a, success: true, points: 3, officialAnswer: 'Yes' }
        sockets.forEach((socket) => socket.emit({ type: 'state', match: { ...live, game } }))
      },
      __e2eSynchronizeAnswer: (side: 'a' | 'b', answer: number) => sockets.forEach((socket) => socket.synchronizeAnswer(side, answer)),
      __e2eExpireQuestion: () => sockets.forEach((socket) => socket.expireQuestion()),
      __e2eSetQuestionDeadline: (deadline: number | null) => {
        if (!live.game) return
        live.game.questionDeadlineAt = deadline
        sockets.forEach((socket) => socket.emit({ type: 'state', match: live }))
      },
      __e2eSetPreRevealDelta: () => {
        if (!live.game) return
        const game = live.game as { scores: Array<Record<string, unknown>> }
        game.scores = game.scores.map((score, index) => ({ ...score, delta: index + 7 }))
        sockets.forEach((socket) => socket.emit({ type: 'state', match: live }))
      },
      __e2eSetFinalTtmcRound: () => {
        if (live.gameMode !== 'ttmc' || !live.game) return
        const game = live.game as { roundNumber: number; totalRounds: number }
        game.roundNumber = game.totalRounds
        sockets.forEach((socket) => socket.emit({ type: 'state', match: live }))
      },
      __e2eSetTtmcRoundNumber: (roundNumber: number) => {
        if (live.gameMode !== 'ttmc' || !live.game) return
        const game = live.game as { roundNumber: number; teams: Record<'a' | 'b', Record<string, unknown>> }
        game.roundNumber = roundNumber
        game.teams.a = { ...game.teams.a, difficulty: null, submitted: false, question: null }
        game.teams.b = { ...game.teams.b, difficulty: null, submitted: false, question: null }
        sockets.forEach((socket) => socket.emit({ type: 'state', match: live }))
      },
      __e2eSetUpstreamConnected: (connected: boolean) => {
        live.connected = connected
        sockets.forEach((socket) => socket.emit({ type: 'state', match: live }))
      },
      __e2eMalformedIdentity: () => sockets.forEach((socket) => socket.emitMalformedIdentity()),
      __e2eMalformedConnection: () => sockets.forEach((socket) => socket.emit({ type: 'connection', connected: true })),
      __e2eMalformedNextActionResult: () => { malformedNextActionResult = true },
      __e2eDisconnect: (failures: number) => {
        failedConnectionsRemaining = failures
        sockets.forEach((socket) => socket.serverDisconnect())
      },
      __e2eFailedConnectionsRemaining: () => failedConnectionsRemaining,
    })
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: TestWebSocket })
  }, { matchId: match.id })
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = []
  browserErrors.set(page, errors)
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  await mockLiveSocket(page)
  apiStates.set(page, await mockApi(page))
})

test.afterEach(async ({ page }) => {
  const api = apiState(page)
  const unexpectedBrowserErrors = (browserErrors.get(page) ?? [])
    .filter((message) => !api.allowedBrowserErrors.some((pattern) => pattern.test(message)))
  expect(unexpectedBrowserErrors, 'The page emitted browser errors').toEqual([])
  expect(api.unexpectedRequests, 'The app made API requests absent from the test contract').toEqual([])
})

function apiState(page: Page): MockApiState {
  const state = apiStates.get(page)
  if (!state) throw new Error('API mock state was not initialized')
  return state
}

function tabButton(page: Page, name: string) {
  return page.getByRole('navigation', { name: 'Game sections' })
    .getByRole('button', { name: new RegExp(`${name}$`, 'i') })
}

async function createMatchFromQuote(page: Page) {
  await page.goto('/')
  const create = page.getByRole('button', { name: /Create match — 100 grooopies/ })
  await expect(create).toBeEnabled()
  await create.focus()
  await create.press('Enter')
  await expect(page.getByText('Live connection')).toBeVisible()
}

async function startQuestion(page: Page) {
  await createMatchFromQuote(page)
  await page.getByRole('button', { name: 'Start first question →' }).click()
  await expect(page.getByRole('heading', { name: 'How many roads must a player walk down?' })).toBeVisible()
}

async function startTtmcMatch(page: Page) {
  await page.goto('/')
  await page.getByRole('radio', { name: /TTMC/i }).check()
  await expect(page.getByRole('checkbox', { name: 'Included' })).toBeChecked()
  await page.getByRole('button', { name: /Create match — 100 grooopies/ }).click()
  await expect(page.getByText('Live connection')).toBeVisible()
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __e2eSetTtmcWaiting: () => void }).__e2eSetTtmcWaiting()
  })
  await page.getByRole('button', { name: 'Start first topic →' }).click()
  await expect(page.getByRole('heading', { name: 'TTMC' })).toBeVisible()
}

test('automatically refreshes an exact quote when setup changes', async ({ page }) => {
  const api = apiState(page)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /LET’S PLAY/i })).toBeVisible()
  await expect(page.getByText('100 grooopies', { exact: true })).toBeVisible()
  const previousQuotes = api.quoteRequests.length

  await page.getByRole('textbox', { name: 'Team A name' }).fill('North Side')
  await expect.poll(() => api.quoteRequests.length).toBeGreaterThan(previousQuotes)
  await expect(page.getByRole('button', { name: /Create match — 100 grooopies/ })).toBeEnabled()
  expect(api.quoteRequests.at(-1)?.teamA).toMatchObject({ name: 'North Side' })
})

test('recovers from an automatic pricing failure without recreating the setup', async ({ page }) => {
  const api = apiState(page)
  api.quoteFailuresRemaining = 1
  api.allowedBrowserErrors.push(/status of 503 \(Service Unavailable\)/)
  await page.goto('/')

  await expect(page.getByRole('alert')).toHaveText('Could not price this match.')
  await expect(page.getByRole('button', { name: 'Retry price' })).toBeVisible()
  await page.getByRole('button', { name: 'Retry price' }).click()

  await expect(page.getByRole('button', { name: /Create match — 100 grooopies/ })).toBeEnabled()
  expect(api.quoteRequests).toHaveLength(2)
  expect(api.quoteRequests[1]).toEqual(api.quoteRequests[0])
})

test('selects all Proximo categories by default', async ({ page }) => {
  const api = apiState(page)
  await page.goto('/')
  await expect(page.getByRole('radio', { name: /^all /i })).toBeChecked()
  await page.getByRole('button', { name: /Create match — 100 grooopies/ }).click()
  expect(api.createBodies[0].contentSlug).toBe('all')
})

test('selects TTMC packs, invalidates its quote, and records them', async ({ page }) => {
  const api = apiState(page)
  await page.goto('/')
  await page.getByRole('radio', { name: /TTMC/i }).check()
  const included = page.getByRole('checkbox', { name: 'Included' })
  const musique = page.getByRole('checkbox', { name: 'TTMC Musique' })
  const bonneBouffe = page.getByRole('checkbox', { name: 'TTMC Bonne Bouffe' })
  await expect(included).toBeChecked()
  await expect(musique).toBeChecked()
  await expect(bonneBouffe).toBeChecked()
  await expect(page.locator('.ttmc-all-packs').filter({ hasText: 'All packs selected' })).toBeVisible()
  await bonneBouffe.uncheck()
  const selectAll = page.getByRole('button', { name: 'Select all packs' })
  await expect(selectAll).toBeEnabled()
  await expect(page.getByText('100 grooopies', { exact: true })).toBeVisible()
  await selectAll.click()
  await expect(included).toBeChecked()
  await expect(musique).toBeChecked()
  await expect(bonneBouffe).toBeChecked()
  await expect(page.locator('.ttmc-all-packs').filter({ hasText: 'All packs selected' })).toBeVisible()
  const topics = page.getByRole('slider', { name: 'Topics' })
  await expect(topics).toHaveAttribute('min', '2')
  await expect(topics).toHaveAttribute('max', '10')
  await expect(topics).toHaveValue('5')
  await topics.fill('7')
  await expect(page.getByText('7', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: /Create match — 100 grooopies/ }).click()
  expect(api.createBodies[0]).toMatchObject({ gameMode: 'ttmc', rounds: 7 })
  expect(api.createBodies[0].ttmcContentSlugs).toEqual(['included', 'ttmc-musique', 'ttmc-bonnebouffe'])
  expect(api.createBodies[0]).not.toHaveProperty('contentSlug')
  expect(api.createBodies[0]).not.toHaveProperty('durationMinutes')
  await tabButton(page, 'history').click()
  await expect(page.getByText('TTMC · 7 topics · included · ttmc-musique · ttmc-bonnebouffe')).toBeVisible()
})

test('uses only the current host TTMC catalog and ownership', async ({ page }) => {
  const api = apiState(page)
  api.ttmcCatalogs['account-b'] = { owned: false, contents: [{ slug: 'included', title: 'Unavailable host pack' }], rounds: { min: 2, max: 10, default: 5, step: 1 } }
  api.ttmcCatalogs['account-a'] = { owned: true, contents: [{ slug: 'included', title: 'Available host pack' }], rounds: { min: 2, max: 10, default: 5, step: 1 } }
  await page.goto('/')
  await page.getByRole('radio', { name: /TTMC/i }).check()
  await expect(page.getByRole('alert').filter({ hasText: 'The selected host does not own TTMC.' })).toBeVisible()
  await expect(page.locator('.create-button')).toBeDisabled()

  await page.getByRole('combobox', { name: /^Host/ }).selectOption('a')
  await expect(page.getByRole('checkbox', { name: 'Available host pack' })).toBeChecked()
  await expect(page.getByText('Unavailable host pack')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Create match — 100 grooopies/ })).toBeEnabled()
})

test('discards a stale TTMC catalog after the host changes', async ({ page }) => {
  const api = apiState(page)
  api.ttmcCatalogs['account-b'] = { owned: true, contents: [{ slug: 'included', title: 'Slow host pack' }], rounds: { min: 2, max: 10, default: 5, step: 1 } }
  api.ttmcCatalogs['account-a'] = { owned: true, contents: [{ slug: 'included', title: 'Current host pack' }], rounds: { min: 2, max: 10, default: 5, step: 1 } }
  api.ttmcCatalogDelays['account-b'] = 400
  await page.goto('/')
  await page.getByRole('radio', { name: /TTMC/i }).check()
  await page.getByRole('combobox', { name: /^Host/ }).selectOption('a')
  await expect(page.getByRole('checkbox', { name: 'Current host pack' })).toBeChecked()
  await page.waitForTimeout(450)
  await expect(page.getByText('Slow host pack')).toHaveCount(0)
})

test('keeps All packs complete when the host catalog adds a pack', async ({ page }) => {
  const api = apiState(page)
  await page.goto('/')
  await page.getByRole('radio', { name: /TTMC/i }).check()
  api.ttmcCatalogs['account-b'].contents.push({ slug: 'ttmc-cinema', title: 'TTMC Cinema' })
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.locator('.account-list li').filter({ hasText: 'gmail.com' }).getByRole('button', { name: 'Refresh' }).click()
  await page.getByRole('button', { name: 'Play' }).click()
  await expect(page.getByRole('checkbox', { name: 'TTMC Cinema' })).toBeChecked()
  await expect(page.locator('.ttmc-all-packs').filter({ hasText: 'All packs selected' })).toBeVisible()
})

test('treats manually completing the selection as All packs on refresh', async ({ page }) => {
  const api = apiState(page)
  await page.goto('/')
  await page.getByRole('radio', { name: /TTMC/i }).check()
  const bonneBouffe = page.getByRole('checkbox', { name: 'TTMC Bonne Bouffe' })
  await bonneBouffe.uncheck()
  await bonneBouffe.check()
  await expect(page.locator('.ttmc-all-packs').filter({ hasText: 'All packs selected' })).toBeVisible()

  api.ttmcCatalogs['account-b'].contents.push({ slug: 'ttmc-cinema', title: 'TTMC Cinema' })
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.locator('.account-list li').filter({ hasText: 'gmail.com' }).getByRole('button', { name: 'Refresh' }).click()
  await page.getByRole('button', { name: 'Play' }).click()

  await expect(page.getByRole('checkbox', { name: 'TTMC Cinema' })).toBeChecked()
})

test('preserves only available custom TTMC pack selections on refresh', async ({ page }) => {
  const api = apiState(page)
  await page.goto('/')
  await page.getByRole('radio', { name: /TTMC/i }).check()
  await page.getByRole('checkbox', { name: 'TTMC Bonne Bouffe' }).uncheck()
  api.ttmcCatalogs['account-b'].contents = [
    { slug: 'included', title: 'Included' },
    { slug: 'ttmc-musique', title: 'TTMC Musique' },
    { slug: 'ttmc-cinema', title: 'TTMC Cinema' },
  ]
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.locator('.account-list li').filter({ hasText: 'gmail.com' }).getByRole('button', { name: 'Refresh' }).click()
  await page.getByRole('button', { name: 'Play' }).click()
  await expect(page.getByRole('checkbox', { name: 'Included' })).toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'TTMC Musique' })).toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'TTMC Cinema' })).not.toBeChecked()
  await expect(page.getByRole('button', { name: 'Select all packs' })).toBeEnabled()
})

test('preserves custom TTMC selections independently for each host', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('radio', { name: /TTMC/i }).check()
  await page.getByRole('checkbox', { name: 'TTMC Bonne Bouffe' }).uncheck()
  await page.getByRole('combobox', { name: /^Host/ }).selectOption('a')
  await expect(page.getByRole('checkbox', { name: 'Included' })).toBeChecked()
  await page.getByRole('checkbox', { name: 'TTMC Musique' }).uncheck()
  await page.getByRole('combobox', { name: /^Host/ }).selectOption('b')
  await expect(page.getByRole('checkbox', { name: 'TTMC Bonne Bouffe' })).not.toBeChecked()
  await page.getByRole('combobox', { name: /^Host/ }).selectOption('a')
  await expect(page.getByRole('checkbox', { name: 'TTMC Musique' })).not.toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'TTMC Bonne Bouffe' })).toBeChecked()
})

test('does not broaden an empty custom TTMC selection after refresh', async ({ page }) => {
  const api = apiState(page)
  await page.goto('/')
  await page.getByRole('radio', { name: /TTMC/i }).check()
  await page.getByRole('checkbox', { name: 'Included' }).uncheck()
  await page.getByRole('checkbox', { name: 'TTMC Musique' }).uncheck()
  api.ttmcCatalogs['account-b'].contents = [{ slug: 'ttmc-cinema', title: 'TTMC Cinema' }]
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.locator('.account-list li').filter({ hasText: 'gmail.com' }).getByRole('button', { name: 'Refresh' }).click()
  await page.getByRole('button', { name: 'Play' }).click()
  await expect(page.getByRole('checkbox', { name: 'TTMC Cinema' })).not.toBeChecked()
  await expect(page.getByRole('alert').filter({ hasText: 'Select at least one TTMC pack to price this match.' })).toBeVisible()
  await expect(page.locator('.create-button')).toBeDisabled()
})

test('retries a failed TTMC catalog load', async ({ page }) => {
  const api = apiState(page)
  api.ttmcCatalogFailuresRemaining['account-b'] = 1
  api.allowedBrowserErrors.push(/status of 503/)
  await page.goto('/')
  await page.getByRole('radio', { name: /TTMC/i }).check()
  const retry = page.getByRole('button', { name: 'Retry loading TTMC packs' })
  await expect(retry).toBeVisible()
  await retry.focus()
  await retry.press('Enter')
  await expect(page.getByRole('checkbox', { name: 'Included' })).toBeChecked()
})

test('explains an owned TTMC catalog with no packs', async ({ page }) => {
  const api = apiState(page)
  api.ttmcCatalogs['account-b'].contents = []
  await page.goto('/')
  await page.getByRole('radio', { name: /TTMC/i }).check()
  await expect(page.getByRole('alert').filter({ hasText: 'No TTMC packs are available for the selected host.' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Select all packs' })).toHaveCount(0)
  await expect(page.getByRole('slider', { name: 'Topics' })).toBeDisabled()
})

test('uses TTMC catalog round bounds and normalizes its default', async ({ page }) => {
  const api = apiState(page)
  api.ttmcCatalogs['account-b'].rounds = { min: 4, max: 10, default: 8, step: 2 }
  await page.goto('/')
  await page.getByRole('radio', { name: /TTMC/i }).check()
  const topics = page.getByRole('slider', { name: 'Topics' })
  await expect(topics).toHaveAttribute('min', '4')
  await expect(topics).toHaveAttribute('max', '10')
  await expect(topics).toHaveAttribute('step', '2')
  await expect(topics).toHaveValue('8')
})

test('runs TTMC team turns sequentially without exposing answers before the authoritative result', async ({ page }) => {
  await startTtmcMatch(page)
  const board = page.getByRole('region', { name: 'TTMC' })
  await expect(page.getByText('Up now', { exact: true })).toBeVisible()
  await expect(board.getByRole('heading', { name: 'Team A', exact: true })).toBeVisible()
  await expect(board.getByRole('heading', { name: 'Team B', exact: true })).toHaveCount(0)
  await page.getByRole('group', { name: 'Team A difficulty' }).getByRole('button', { name: '1', exact: true }).click()
  await page.getByRole('button', { name: 'Lock in 1 for Team A →' }).click()
  await expect(page.getByText('Is the secret switch on?', { exact: true })).toBeVisible()
  await expect(page.getByText('Team B, read this aloud.')).toBeVisible()
  if ((await page.viewportSize())?.width === 390) {
    const widths = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    }))
    expect(widths.content).toBeLessThanOrEqual(widths.viewport)
    await expect(page.getByRole('button', { name: 'Lock Team A answer' })).toBeVisible()
  }
  await page.getByRole('button', { name: 'Yes' }).click()
  await page.getByRole('button', { name: 'Lock Team A answer' }).click()

  await expect(board.getByRole('heading', { name: 'Team B', exact: true })).toBeVisible()
  await expect(page.getByText('Choose the two bright moons.', { exact: true })).toHaveCount(0)
  await page.getByRole('group', { name: 'Team B difficulty' }).getByRole('button', { name: '10', exact: true }).click()
  await page.getByRole('button', { name: 'Lock in 10 for Team B →' }).click()
  await expect(page.getByText('Team A, read this aloud.')).toBeVisible()
  await page.getByRole('button', { name: 'Io' }).click()
  await page.getByRole('button', { name: 'Europa' }).click()
  await page.getByRole('button', { name: 'Lock Team B answer' }).click()
  await expect(page.getByText('Both turns are locked. Waiting for the topic result.')).toBeVisible()
  await expect(page.locator('body')).not.toContainText('Official answer')
  await expect(page.locator('body')).not.toContainText('Correct')
  expect(await page.evaluate(() => {
    return (globalThis as typeof globalThis & { __e2eSocketCommands: LiveCommand[] }).__e2eSocketCommands
      .filter((command) => command.type === 'start-ttmc-question' || command.type === 'ttmc-answers')
  })).toEqual([
    expect.objectContaining({ type: 'start-ttmc-question', roundId: 777, side: 'a', difficulty: 0 }),
    expect.objectContaining({ type: 'ttmc-answers', roundId: 777, answers: { a: true } }),
    expect.objectContaining({ type: 'start-ttmc-question', roundId: 777, side: 'b', difficulty: 9 }),
    expect.objectContaining({ type: 'ttmc-answers', roundId: 777, answers: { b: [0, 1] } }),
  ])

  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __e2eFinishTtmcRound: () => void }).__e2eFinishTtmcRound()
  })
  await expect(page.getByText(/Correct.*3 points/)).toBeVisible()
  await expect(page.getByText(/Incorrect.*0 points/)).toBeVisible()
  await expect(page.getByRole('region', { name: 'TTMC' }).getByText('Yes', { exact: true })).toBeVisible()
  await expect(page.getByText('Io · Europa')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Topic complete. Start a fresh topic.' })).toBeVisible()
  await expect(page.getByRole('group', { name: /Team [AB] difficulty/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'Start next topic →' }).click()
  expect(await page.evaluate(() => {
    return (globalThis as typeof globalThis & { __e2eSocketCommands: LiveCommand[] }).__e2eSocketCommands.findLast((command) => command.type === 'next-ttmc-round')
  })).toMatchObject({ type: 'next-ttmc-round', roundId: 777 })
})

test('does not expose Team B controls until Team A submits', async ({ page }) => {
  await startTtmcMatch(page)
  await expect(page.getByRole('group', { name: 'Team B difficulty' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Lock in 1 for Team A →' }).click()
  await page.locator('.ttmc-team.side-a').getByRole('button', { name: 'Yes' }).click()
  await page.getByRole('button', { name: 'Lock Team A answer' }).click()

  expect(await page.evaluate(() => {
    return (globalThis as typeof globalThis & { __e2eSocketCommands: LiveCommand[] }).__e2eSocketCommands.findLast((command) => command.type === 'ttmc-answers')
  })).toMatchObject({ type: 'ttmc-answers', roundId: 777, answers: { a: true } })
  await expect(page.locator('.ttmc-team.side-a').getByRole('button', { name: 'Yes' })).toHaveCount(0)
  await expect(page.getByRole('group', { name: 'Team B difficulty' })).toBeVisible()
  await expect(page.getByText('Choose the two bright moons.')).toHaveCount(0)
})

test('alternates which team opens each TTMC topic', async ({ page }) => {
  await startTtmcMatch(page)
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __e2eSetTtmcRoundNumber: (round: number) => void }).__e2eSetTtmcRoundNumber(2)
  })
  await expect(page.getByRole('region', { name: 'TTMC' }).getByRole('heading', { name: 'Team B', exact: true })).toBeVisible()
  await expect(page.getByRole('group', { name: 'Team B difficulty' })).toBeVisible()
  await expect(page.getByRole('group', { name: 'Team A difficulty' })).toHaveCount(0)
})

test('rejects TTMC results before the authoritative finished state', async ({ page }) => {
  await startTtmcMatch(page)
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __e2eEmitEarlyTtmcResult: () => void }).__e2eEmitEarlyTtmcResult()
  })
  await expect(page.getByText(/Correct.*3 points/)).toHaveCount(0)
  await expect(page.getByText('Live connection')).toBeVisible()
})

test('announces TTMC topic, question, and result transitions and waits after the final topic', async ({ page }) => {
  await startTtmcMatch(page)
  const liveRegion = page.locator('.sr-only[aria-live="polite"]')
  await expect(liveRegion).toContainText('TTMC topic 1 of 7: Twin topics')
  await page.getByRole('button', { name: 'Lock in 1 for Team A →' }).click()
  await expect(liveRegion).toContainText('Team A question: Is the secret switch on?')
  await page.getByRole('button', { name: 'Yes' }).click()
  await page.getByRole('button', { name: 'Lock Team A answer' }).click()
  await page.getByRole('button', { name: 'Lock in 1 for Team B →' }).click()
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __e2eSetFinalTtmcRound: () => void }).__e2eSetFinalTtmcRound()
  })
  await expect(liveRegion).toContainText('TTMC topic 7 of 7: Twin topics')
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __e2eFinishTtmcRound: () => void }).__e2eFinishTtmcRound()
  })

  await expect(liveRegion).toContainText('TTMC topic result: Team A correct, 3 points')
  await expect(page.getByRole('heading', { name: 'All topics are complete.' })).toBeVisible()
  await expect(page.getByText('Both teams are finished. Waiting for Grooop to close the match.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start next topic →' })).toHaveCount(0)
  expect(await page.evaluate(() => {
    return (globalThis as typeof globalThis & { __e2eSocketCommands: LiveCommand[] }).__e2eSocketCommands
      .filter((command) => command.type === 'next-ttmc-round' || command.type === 'finish')
  })).toEqual([])
})

test('reconnects after a mismatched action result instead of leaving controls pending', async ({ page }) => {
  await createMatchFromQuote(page)
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __e2eMalformedNextActionResult: () => void }).__e2eMalformedNextActionResult()
  })
  await page.getByRole('button', { name: 'Start first question →' }).click()
  await expect(page.getByRole('heading', { name: 'How many roads must a player walk down?' })).toBeVisible()
})

test('sends number, one-word, and ordered-word TTMC answers with their contract payloads', async ({ page }) => {
  await startTtmcMatch(page)
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __e2eSetTtmcState: (a: Record<string, unknown>, b: Record<string, unknown>, started: boolean) => void }).__e2eSetTtmcState(
      { type: 'number', prompt: 'How many hidden stars?', min: 2, max: 8, step: 2 },
      { type: 'oneword', prompt: 'Name the hidden star.' },
      true,
    )
  })
  await page.getByRole('slider', { name: 'Team A answer' }).fill('6')
  await page.getByRole('button', { name: 'Lock Team A answer' }).click()
  expect(await page.evaluate(() => {
    return (globalThis as typeof globalThis & { __e2eSocketCommands: LiveCommand[] }).__e2eSocketCommands.findLast((command) => command.type === 'ttmc-answers')
  })).toMatchObject({ type: 'ttmc-answers', roundId: 777, answers: { a: 6 } })
  await page.getByRole('textbox', { name: 'Team B answer' }).fill('  Nebula-Password  ')
  await page.getByRole('button', { name: 'Lock Team B answer' }).click()
  await expect(page.locator('body')).not.toContainText('Nebula-Password')
  expect(await page.evaluate(() => {
    return (globalThis as typeof globalThis & { __e2eSocketCommands: LiveCommand[] }).__e2eSocketCommands.findLast((command) => command.type === 'ttmc-answers')
  })).toMatchObject({ type: 'ttmc-answers', roundId: 777, answers: { b: 'nebula-password' } })

  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __e2eSetTtmcState: (a: Record<string, unknown>, b: Record<string, unknown>, started: boolean) => void }).__e2eSetTtmcState(
      { type: 'words', prompt: 'Put the launch in order.', candidates: ['ignite', 'countdown', 'liftoff'], answerWordCount: 3 },
      { type: 'bool', prompt: 'Unused second question.' },
      true,
    )
  })
  await page.getByRole('button', { name: 'countdown' }).click()
  await page.getByRole('button', { name: 'ignite' }).click()
  await page.getByRole('button', { name: 'liftoff' }).click()
  await page.getByRole('button', { name: 'Lock Team A answer' }).click()
  expect(await page.evaluate(() => {
    return (globalThis as typeof globalThis & { __e2eSocketCommands: LiveCommand[] }).__e2eSocketCommands.findLast((command) => command.type === 'ttmc-answers')
  })).toMatchObject({ type: 'ttmc-answers', roundId: 777, answers: { a: ['countdown', 'ignite', 'liftoff'] } })
})

test('defaults the host to the selected account with fewer grooopies', async ({ page }) => {
  const api = apiState(page)
  await page.goto('/')
  await expect(page.getByLabel('Host')).toHaveValue('b')
  await page.getByRole('button', { name: /Create match — 100 grooopies/ }).click()
  expect(api.createBodies[0].hostAccountId).toBe('account-b')
})

test('restores the newest active match after a page reload', async ({ page }) => {
  apiState(page).matches = [structuredClone(match)]
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /ON THE AIR/i })).toBeVisible()
  await expect(page.getByText('Live connection')).toBeVisible()

  await page.reload()
  await expect(page.getByRole('heading', { name: /ON THE AIR/i })).toBeVisible()
  await expect(page.getByText('Live connection')).toBeVisible()
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })))
    .toEqual({ local: 0, session: 0 })
})

test('resumes a joining match after reload without creating another party', async ({ page }) => {
  const api = apiState(page)
  api.matches = [{ ...structuredClone(match), status: 'joining', error: 'party-not-ready' }]
  await page.goto('/')

  await expect(page.getByRole('heading', { name: /ON THE AIR/i })).toBeVisible()
  await expect(page.getByText('Live connection')).toBeVisible()
  expect(api.createBodies).toEqual([])
  expect(api.matches[0].status).toBe('waiting')
})

test('uses one UUID idempotency key across a failed create retry', async ({ page }) => {
  const api = apiState(page)
  api.createFailuresRemaining = 1
  api.allowedBrowserErrors.push(/status of 503 \(Service Unavailable\)/)
  await page.goto('/')
  const create = page.getByRole('button', { name: /Create match — 100 grooopies/ })
  await create.focus()
  await create.press('Enter')
  await expect(page.getByRole('alert')).toHaveText('Create failed. Try again.')
  await expect(create).toBeEnabled()
  await create.focus()
  await create.press('Enter')
  await expect(page.getByText('Live connection')).toBeVisible()

  expect(api.createBodies).toHaveLength(2)
  const keys = api.createBodies.map((body) => body.idempotencyKey)
  expect(keys[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  expect(keys[1]).toBe(keys[0])
})

test('offers a retry when automatic Proximo readiness is rejected', async ({ page }) => {
  await createMatchFromQuote(page)
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __e2eRejectNextCommand: (type: string) => void })
      .__e2eRejectNextCommand('ready')
  })

  await page.getByRole('button', { name: 'Start first question →' }).click()
  await expect(page.getByRole('alert')).toHaveText('Answer rejected for this test.')
  await page.getByRole('button', { name: 'Retry opening question' }).click()

  await expect(page.getByRole('heading', { name: 'How many roads must a player walk down?' })).toBeVisible()
  expect(await page.evaluate(() => {
    const commands = (globalThis as typeof globalThis & { __e2eSocketCommands: LiveCommand[] }).__e2eSocketCommands
    return commands.filter((command) => command.type === 'start-proximo' || command.type === 'ready').map((command) => command.type)
  })).toEqual(['start-proximo', 'ready', 'ready'])
})

test('clears a stale quote and idempotency key when the party cost changes', async ({ page }) => {
  const api = apiState(page)
  api.costChangesRemaining = 1
  api.allowedBrowserErrors.push(/status of 409 \(Conflict\)/)
  await page.goto('/')
  await page.getByRole('button', { name: /Create match — 100 grooopies/ }).click()

  await expect(page.getByRole('alert')).toHaveText('Party cost changed; review the new quote')
  await expect.poll(() => api.quoteRequests.length).toBeGreaterThan(1)
  const repriced = page.getByRole('button', { name: /Create match — 100 grooopies/ })
  await expect(repriced).toBeEnabled()
  await repriced.click()
  await expect(page.getByText('Live connection')).toBeVisible()
  expect(api.createBodies[1].idempotencyKey).not.toBe(api.createBodies[0].idempotencyKey)
})

test('rejects a created match whose status is not live', async ({ page }) => {
  apiState(page).createdMatchStatus = 'creating'
  await page.goto('/')
  await page.getByRole('button', { name: /Create match — 100 grooopies/ }).click()

  await expect(page.getByRole('alert')).toHaveText('The match returned an invalid status: creating.')
  await expect(page.getByRole('heading', { name: /LET’S PLAY/i })).toBeVisible()
})

test('locks both answers in one action, conceals them, then reveals from the server', async ({ page }) => {
  await startQuestion(page)
  const answerA = page.getByRole('spinbutton', { name: 'Team A answer' })
  const answerB = page.getByRole('spinbutton', { name: 'Team B answer' })
  const lock = page.getByRole('button', { name: 'Lock both answers' })
  await answerA.fill('40')
  await answerB.fill('42')

  await lock.click()
  await expect(page.getByRole('button', { name: 'Both answers locked' })).toBeDisabled()
  await expect(answerA).toBeDisabled()
  await expect(answerB).toBeDisabled()
  await expect(answerA).toHaveValue('')
  await expect(answerB).toHaveValue('')
  await expect(page.getByText('Official answer')).toHaveCount(0)
  await expect(page.locator('.score-list')).not.toContainText(/Answer (40|42)/)
  expect(await page.evaluate(() => {
    const commands = (globalThis as typeof globalThis & { __e2eSocketCommands: Array<Record<string, unknown>> }).__e2eSocketCommands
    return commands.find((command) => command.type === 'answers')
  })).toMatchObject({ type: 'answers', gameId: 456, currentRound: 0, answers: { a: 40, b: 42 } })

  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __e2eRevealAnswers: () => void }).__e2eRevealAnswers()
  })
  await expect(page.getByText('Official answer')).toBeVisible()
  await expect(page.getByText('Answer 40')).toBeVisible()
  await expect(page.getByText('Answer 42')).toBeVisible()
})

test('recovers a partial synchronized answer without exposing or resending it', async ({ page }) => {
  await startQuestion(page)
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __e2eSynchronizeAnswer: (side: 'a' | 'b', answer: number) => void })
      .__e2eSynchronizeAnswer('a', 40)
  })

  const answerA = page.getByRole('spinbutton', { name: 'Team A answer' })
  const answerB = page.getByRole('spinbutton', { name: 'Team B answer' })
  await expect(answerA).toBeDisabled()
  await expect(answerA).toHaveValue('')
  await expect(page.getByText('Still needed')).toBeVisible()
  await expect(page.locator('.score-list')).not.toContainText('Answer 40')
  await answerB.fill('42')
  await page.getByRole('button', { name: 'Lock Team B answer' }).click()

  expect(await page.evaluate(() => {
    const commands = (globalThis as typeof globalThis & { __e2eSocketCommands: Array<Record<string, unknown>> }).__e2eSocketCommands
    return commands.findLast((command) => command.type === 'answers')
  })).toMatchObject({ type: 'answers', gameId: 456, currentRound: 0, answers: { b: 42 } })
})

test('closes answer controls when the synchronized deadline expires', async ({ page }) => {
  await startQuestion(page)
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __e2eExpireQuestion: () => void }).__e2eExpireQuestion()
  })

  await expect(page.getByRole('timer')).toContainText('00:00')
  await expect(page.getByText('Answering is closed for this question.')).toBeVisible()
  await expect(page.getByRole('spinbutton', { name: 'Team A answer' })).toBeDisabled()
  await expect(page.getByRole('spinbutton', { name: 'Team B answer' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Answering closed' })).toBeDisabled()
  expect(await page.evaluate(() => {
    const commands = (globalThis as typeof globalThis & { __e2eSocketCommands: Array<{ type: string }> }).__e2eSocketCommands
    return commands.filter((command) => command.type === 'answers')
  })).toHaveLength(0)
})

test('fails closed on a malformed game identity instead of sending a stale command', async ({ page }) => {
  await startQuestion(page)
  const commandCount = await page.evaluate(() => {
    return (globalThis as typeof globalThis & { __e2eSocketCommands: unknown[] }).__e2eSocketCommands.length
  })
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __e2eMalformedIdentity: () => void }).__e2eMalformedIdentity()
  })

  await expect(page.getByText('Live connection')).toBeVisible()
  expect(await page.evaluate(() => {
    return (globalThis as typeof globalThis & { __e2eSocketCommands: unknown[] }).__e2eSocketCommands.length
  })).toBe(commandCount)
})

test('reconnects after a malformed connection frame', async ({ page }) => {
  await startQuestion(page)
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __e2eMalformedConnection: () => void })
      .__e2eMalformedConnection()
  })
  await expect(page.getByText('Live connection')).toBeVisible()
  await expect(page.getByRole('spinbutton', { name: 'Team A answer' })).toBeEnabled()
})

test('shows a prominent countdown and adds the next question in the same match', async ({ page }) => {
  await startQuestion(page)
  const timer = page.getByRole('timer')
  await expect(timer).toContainText('Time left')
  const first = await timer.locator('b').innerText()
  expect(first).toMatch(/^00:(29|30)$/)
  await page.waitForTimeout(1_100)
  expect(await timer.locator('b').innerText()).not.toBe(first)

  await page.getByRole('spinbutton', { name: 'Team A answer' }).fill('40')
  await page.getByRole('spinbutton', { name: 'Team B answer' }).fill('42')
  await page.getByRole('button', { name: 'Lock both answers' }).click()
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __e2eRevealAnswers: () => void }).__e2eRevealAnswers()
  })
  const next = page.getByRole('button', { name: 'Start next question →' })
  await expect(next).toBeVisible()
  await next.click()
  await expect(page.getByRole('heading', { name: 'How many planets orbit the Sun?' })).toBeVisible()
  expect(await page.evaluate(() => {
    const commands = (globalThis as typeof globalThis & { __e2eSocketCommands: Array<Record<string, unknown>> }).__e2eSocketCommands
    return commands.filter((command) => command.type === 'ready' || command.type === 'next-proximo')
  })).toEqual([
    expect.objectContaining({ type: 'ready', gameId: 456 }),
    expect.objectContaining({ type: 'next-proximo', gameId: 456 }),
    expect.objectContaining({ type: 'ready', gameId: 457 }),
  ])
})

test('hides terminal controls after ending a match', async ({ page }) => {
  await startQuestion(page)
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'End match' }).click()
  await expect(page.getByText('This match is closed. Its result remains in History.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'End match' })).toHaveCount(0)
})

test('can confirm a match-wide finish before a game exists', async ({ page }) => {
  await createMatchFromQuote(page)
  const finish = page.getByRole('button', { name: 'End match' })
  await expect(finish).toBeVisible()

  page.once('dialog', (dialog) => dialog.dismiss())
  await finish.click()
  await expect(finish).toBeVisible()
  page.once('dialog', (dialog) => dialog.accept())
  await finish.click()
  await expect(page.getByText('This match is closed. Its result remains in History.')).toBeVisible()
})

test('resets reconnect budget after valid state and offers a manual retry at the limit', async ({ page }) => {
  await createMatchFromQuote(page)
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __e2eDisconnect: (failures: number) => void }).__e2eDisconnect(5)
  })
  await expect.poll(() => page.evaluate(() => {
    return (globalThis as typeof globalThis & { __e2eFailedConnectionsRemaining: () => number }).__e2eFailedConnectionsRemaining()
  })).toBe(0)
  await expect(page.getByText('Live connection')).toBeVisible()

  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __e2eDisconnect: (failures: number) => void }).__e2eDisconnect(6)
  })
  const retry = page.getByRole('button', { name: 'Retry live connection' })
  await expect(retry).toBeVisible()
  await expect(page.locator('.party-board')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Start first question →' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'End match' })).toBeDisabled()
  await retry.click()
  await expect(page.getByText('Live connection')).toBeVisible()
  await expect(page.locator('.party-board')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Start first question →' })).toBeEnabled()
})

test('renders observed questions in History', async ({ page }) => {
  apiState(page).questions = structuredClone(observedQuestions)
  await page.goto('/')
  await tabButton(page, 'history').click()

  const archive = page.getByRole('region', { name: 'Question archive' })
  await expect(archive).toBeVisible()
  await expect(archive.getByText('300 / Cinema')).toBeVisible()
  await expect(archive.getByRole('heading', { name: 'How many roads must a player walk down?' })).toBeVisible()
  await expect(archive.getByText('Answer: 42')).toBeVisible()
  await expect(archive.locator('time')).toHaveAttribute('datetime', observedQuestions[0].firstSeenAt)
})

test('loads History matches even when the question archive fails', async ({ page }) => {
  const api = apiState(page)
  api.matches = [structuredClone(match)]
  api.questionFailure = true
  api.allowedBrowserErrors.push(/status of 503 \(Service Unavailable\)/)
  await page.goto('/')
  await tabButton(page, 'history').click()

  await expect(page.getByRole('alert')).toHaveText('Could not load questions.')
  await expect(page.getByRole('heading', { name: 'Team A vs Team B' })).toBeVisible()
})

test('groups every active match and can cancel a previous one', async ({ page }) => {
  const state = apiStates.get(page)!
  state.matches = [
    structuredClone(match),
    { ...structuredClone(match), id: '22222222-2222-4222-8222-222222222222', teamA: { ...match.teamA, name: 'Earlier A' }, teamB: { ...match.teamB, name: 'Earlier B' } },
  ]

  await page.goto('/')
  await tabButton(page, 'history').click()
  await expect(page.getByRole('heading', { name: 'Active matches' })).toBeVisible()
  await expect(page.getByText('Earlier A')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Cancel match' })).toHaveCount(2)

  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Cancel match' }).nth(1).click()
  await expect(page.getByRole('heading', { name: 'Past matches' })).toBeVisible()
  await expect(page.getByText('Earlier A')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Cancel match' })).toHaveCount(1)
})

test('disables setup fields while match creation is in flight', async ({ page }) => {
  const api = apiState(page)
  api.createDelay = 600
  await page.goto('/')
  await page.getByRole('button', { name: /Create match — 100 grooopies/ }).click()

  await expect(page.getByRole('textbox', { name: 'Team A name' })).toBeDisabled()
  await expect(page.getByLabel('Team A account')).toBeDisabled()
  await expect(page.getByRole('radio', { name: /Proximo/i })).toBeDisabled()
  await expect(page.getByText('Live connection')).toBeVisible()
})

test('keeps a TTMC draft when the lock action is rejected', async ({ page }) => {
  await startTtmcMatch(page)
  await page.getByRole('button', { name: 'Lock in 1 for Team A →' }).click()
  const lock = page.getByRole('button', { name: 'Lock Team A answer' })
  await expect(lock).toBeDisabled()
  const yes = page.locator('.ttmc-team.side-a').getByRole('button', { name: 'Yes' })
  await yes.click()
  await expect(lock).toBeEnabled()
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __e2eRejectNextCommand: (type: string) => void }).__e2eRejectNextCommand('ttmc-answers')
  })
  await lock.click()

  await expect(page.getByRole('alert')).toHaveText('Answer rejected for this test.')
  await expect(yes).toHaveAttribute('aria-pressed', 'true')
  await expect(lock).toBeEnabled()
  await expect(page.getByText('Submitted', { exact: true })).toHaveCount(0)
})

test('restores a concealed Proximo draft when the action is rejected', async ({ page }) => {
  await startQuestion(page)
  const answerA = page.getByRole('spinbutton', { name: 'Team A answer' })
  await answerA.fill('40')
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __e2eRejectNextCommand: (type: string) => void })
      .__e2eRejectNextCommand('answers')
  })
  await page.getByRole('button', { name: 'Lock Team A answer' }).click()

  await expect(page.getByRole('alert')).toHaveText('Answer rejected for this test.')
  await expect(answerA).toBeEnabled()
  await expect(answerA).toHaveValue('40')
})

test('blocks quote and create until a delayed active-match restore completes', async ({ page }) => {
  const api = apiState(page)
  api.matches = [structuredClone(match)]
  api.matchGetDelays = [600]
  await page.goto('/')

  await expect(page.getByText('Checking for an active match before opening the match desk…')).toBeVisible()
  await expect(page.locator('.create-button')).toBeDisabled()
  await expect(page.getByRole('heading', { name: /ON THE AIR/i })).toBeVisible()
  expect(api.createBodies).toEqual([])
})

test('does not let a stale initial restore overwrite newer history', async ({ page }) => {
  const api = apiState(page)
  api.matches = [{ ...structuredClone(match), status: 'finished', finishedAt: '2026-07-26T09:00:00.000Z' }]
  api.matchGetDelays = [500, 0]
  await page.goto('/')
  api.matches = [{
    ...structuredClone(match),
    id: '33333333-3333-4333-8333-333333333333',
    status: 'finished',
    teamA: { ...match.teamA, name: 'Newest Team' },
    finishedAt: '2026-07-26T10:00:00.000Z',
  }]
  await page.getByRole('button', { name: 'History' }).click()
  await expect(page.getByRole('heading', { name: /Newest Team/ })).toBeVisible()
  await page.waitForTimeout(550)
  await expect(page.getByRole('heading', { name: /Newest Team/ })).toBeVisible()
  await expect(page.locator('.match-list')).not.toContainText('Team A vs Team B')
})

test('shows an initial restore failure on Play and retries safely', async ({ page }) => {
  const api = apiState(page)
  api.matchFailuresRemaining = 1
  api.allowedBrowserErrors.push(/status of 503 \(Service Unavailable\)/)
  await page.goto('/')

  await expect(page.getByRole('alert')).toContainText('Active match check failed upstream.')
  await expect(page.locator('.create-button')).toBeDisabled()
  await page.getByRole('button', { name: 'Retry active-match check' }).click()
  await expect(page.getByRole('button', { name: /Create match — 100 grooopies/ })).toBeEnabled()
})

test('conceals and submits one-phone Proximo answers independently', async ({ page }) => {
  await startQuestion(page)
  const answerA = page.getByRole('spinbutton', { name: 'Team A answer' })
  const answerB = page.getByRole('spinbutton', { name: 'Team B answer' })
  await answerA.fill('40')
  await page.getByRole('button', { name: 'Lock Team A answer' }).click()

  await expect(answerA).toBeDisabled()
  await expect(answerA).toHaveValue('')
  await expect(answerB).toBeEnabled()
  expect(await page.evaluate(() => {
    const commands = (globalThis as typeof globalThis & { __e2eSocketCommands: LiveCommand[] }).__e2eSocketCommands
    return commands.filter((command) => command.type === 'answers')
  })).toEqual([expect.objectContaining({ answers: { a: 40 } })])

  await expect(page.getByText('Submitted', { exact: true })).toHaveCount(1)
  await answerB.fill('42')
  await page.getByRole('button', { name: 'Lock Team B answer' }).click()
  await expect(answerB).toBeDisabled()
  await expect(answerB).toHaveValue('')
  expect(await page.evaluate(() => {
    const commands = (globalThis as typeof globalThis & { __e2eSocketCommands: LiveCommand[] }).__e2eSocketCommands
    return commands.filter((command) => command.type === 'answers')
  })).toEqual([
    expect.objectContaining({ answers: { a: 40 } }),
    expect.objectContaining({ answers: { b: 42 } }),
  ])
})

test('deduplicates a double-click while an action is in flight', async ({ page }) => {
  await createMatchFromQuote(page)
  await page.getByRole('button', { name: 'Start first question →' }).dblclick()
  expect(await page.evaluate(() => {
    return (globalThis as typeof globalThis & { __e2eSocketCommands: LiveCommand[] }).__e2eSocketCommands
      .filter((command) => command.type === 'start-proximo')
  })).toHaveLength(1)
  await expect(page.getByRole('heading', { name: 'How many roads must a player walk down?' })).toBeVisible()
})

test('fails closed for a null deadline and checks expiration again on submit', async ({ page }) => {
  await startQuestion(page)
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __e2eSetQuestionDeadline: (deadline: number | null) => void }).__e2eSetQuestionDeadline(null)
  })
  await expect(page.getByText('Answering is closed for this question.')).toBeVisible()
  await expect(page.getByRole('spinbutton', { name: 'Team A answer' })).toBeDisabled()

  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __e2eSetQuestionDeadline: (deadline: number | null) => void }).__e2eSetQuestionDeadline(Date.now() + 10_000)
  })
  await page.getByRole('spinbutton', { name: 'Team A answer' }).fill('40')
  await page.getByRole('spinbutton', { name: 'Team B answer' }).fill('42')
  await page.getByRole('button', { name: 'Lock both answers' }).evaluate((button) => {
    const originalNow = Date.now
    Date.now = () => originalNow() + 20_000
    button.click()
    Date.now = originalNow
  })
  await expect(page.getByRole('alert')).toHaveText('Answering is closed for this question.')
  expect(await page.evaluate(() => {
    return (globalThis as typeof globalThis & { __e2eSocketCommands: LiveCommand[] }).__e2eSocketCommands
      .filter((command) => command.type === 'answers')
  })).toHaveLength(0)
})

test('hides Proximo deltas until the authoritative reveal', async ({ page }) => {
  await startQuestion(page)
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __e2eSetPreRevealDelta: () => void }).__e2eSetPreRevealDelta()
  })
  await expect(page.locator('.score-list')).not.toContainText('gap')
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __e2eRevealAnswers: () => void }).__e2eRevealAnswers()
  })
  await expect(page.locator('.score-list')).toContainText('gap +2')
})

test('disables gameplay controls while upstream is disconnected without losing drafts', async ({ page }) => {
  await startQuestion(page)
  const answerA = page.getByRole('spinbutton', { name: 'Team A answer' })
  await answerA.fill('40')
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __e2eSetUpstreamConnected: (connected: boolean) => void }).__e2eSetUpstreamConnected(false)
  })

  await expect(answerA).toBeDisabled()
  await expect(answerA).toHaveValue('40')
  await expect(page.getByRole('button', { name: 'End match' })).toBeDisabled()
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __e2eSetUpstreamConnected: (connected: boolean) => void }).__e2eSetUpstreamConnected(true)
  })
  await expect(answerA).toBeEnabled()
  await expect(answerA).toHaveValue('40')
})

test('applies a team preset and saves a new preset', async ({ page }) => {
  const api = apiState(page)
  await page.goto('/')
  const rosterA = page.getByRole('group', { name: 'Team A roster' })
  await rosterA.getByLabel('Saved team').selectOption(presets[0].id)
  await rosterA.getByRole('button', { name: 'Apply' }).click()

  await expect(page.getByRole('textbox', { name: 'Team A name' })).toHaveValue('The Regulars')
  await expect(page.getByRole('textbox', { name: 'Team A player 1' })).toHaveValue('Ada')
  await expect(page.getByRole('textbox', { name: 'Team A player 3' })).toHaveValue('Katherine')

  const rosterB = page.getByRole('group', { name: 'Team B roster' })
  await page.getByRole('textbox', { name: 'Team B name' }).fill('Late Arrivals')
  await page.getByRole('textbox', { name: 'Team B player 1' }).fill('Mina')
  await page.getByRole('textbox', { name: 'Team B player 2' }).fill('Omar')
  await rosterB.getByRole('button', { name: 'Save', exact: true }).click()

  await expect(rosterB.getByLabel('Saved team')).toHaveValue('33333333-3333-4333-8333-333333333333')
  await expect(rosterB.getByRole('button', { name: 'Update' })).toBeVisible()
  expect(api.presetCreates).toEqual([{ name: 'Late Arrivals', roster: ['Mina', 'Omar'] }])
})

test('starts explicit reauthentication without exposing a full email', async ({ page }) => {
  const api = apiState(page)
  api.accounts[0] = { ...api.accounts[0], email: 're********@example.com', status: 'reauth-required' }
  await page.goto('/')
  await tabButton(page, 'settings').click()
  await page.getByRole('button', { name: 'Re-authenticate' }).click()

  await expect(page.getByRole('heading', { name: 'Verify an account' })).toBeVisible()
  await expect(page.getByText('Code sent to')).toContainText('re********@example.com')
  await expect(page.locator('body')).not.toContainText('reauth.owner@example.com')
  expect(api.reauthenticationRequests).toEqual([{
    path: '/api/accounts/account-a/reauthenticate',
    body: null,
  }])
})

test('reloads accounts after an unauthorized refresh and offers reauthentication', async ({ page }) => {
  const api = apiState(page)
  api.refreshUnauthorized = true
  api.allowedBrowserErrors.push(/status of 401 \(Unauthorized\)/)
  await page.goto('/')
  await tabButton(page, 'settings').click()
  await page.getByRole('button', { name: 'Refresh' }).first().click()

  await expect(page.getByRole('alert')).toHaveText('Grooop rejected this session')
  await expect(page.getByRole('button', { name: 'Re-authenticate' })).toBeVisible()
})

test.describe('service worker', () => {
  test.use({ serviceWorkers: 'allow' })

  test('loads its cached application offline without caching API requests', async ({ page, context, browserName }) => {
    test.skip(browserName === 'webkit', 'WebKit cannot route requests controlled by a service worker')
  await page.goto('/')
  const manifest = await page.evaluate(async () => {
    const response = await fetch('/manifest.webmanifest')
    return response.json() as Promise<{ name: string; start_url: string; display: string; icons: Array<{ purpose: string }> }>
  })
  expect(manifest).toMatchObject({ name: 'Grooop Client', start_url: '/', display: 'standalone' })
  expect(manifest.icons.some((icon) => icon.purpose === 'maskable')).toBe(true)

  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready
    if (registration.active?.state !== 'activated') {
      await new Promise<void>((resolve) => {
        registration.active?.addEventListener('statechange', () => {
          if (registration.active?.state === 'activated') resolve()
        })
      })
    }
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
        once: true,
      }))
    }
  })
  await page.reload()
  await expect(page.getByRole('heading', { name: /LET’S PLAY/i })).toBeVisible()

  const probes = await page.evaluate(async () => {
    const first = await fetch('/api/cache-probe').then((response) => response.json())
    const second = await fetch('/api/cache-probe').then((response) => response.json())
    return [first, second]
  })
  expect(probes).toEqual([{ request: 1 }, { request: 2 }])
  expect(apiState(page).cacheProbeRequests).toBe(2)

  const cachedUrls = await page.evaluate(async () => {
    const urls: string[] = []
    for (const name of await caches.keys()) {
      const cache = await caches.open(name)
      urls.push(...(await cache.keys()).map((request) => request.url))
    }
    return urls
  })
  expect(cachedUrls.length).toBeGreaterThan(0)
  expect(cachedUrls.filter((url) => new URL(url).pathname.startsWith('/api/'))).toEqual([])
  expect(cachedUrls.some((url) => {
    const pathname = new URL(url).pathname
    return pathname.startsWith('/assets/') && pathname.endsWith('.js')
  })).toBe(true)

  apiState(page).allowedBrowserErrors.push(/ERR_INTERNET_DISCONNECTED/)
  await context.setOffline(true)
  try {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: /LET’S PLAY/i })).toBeVisible()
  } finally {
    await context.setOffline(false)
  }
  })
})

test('has no horizontal overflow in mobile portrait or landscape', async ({ page }) => {
  apiState(page).presets[0].name = 'The Extremely Long Saved Team Name'
  await page.goto('/')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('radio', { name: /TTMC/i }).check()
  await expect(page.getByRole('status').filter({ hasText: 'All packs selected' })).toBeVisible()
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport)
    for (const tab of ['play', 'match', 'history', 'settings']) {
      await tabButton(page, tab).click()
      const overflow = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        content: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
        offenders: [...document.querySelectorAll<HTMLElement>('body *')]
          .filter((element) => {
            const bounds = element.getBoundingClientRect()
            return bounds.left < 0 || bounds.right > document.documentElement.clientWidth
          })
          .slice(0, 5)
          .map((element) => `${element.tagName.toLowerCase()}.${element.className}`),
      }))
      expect.soft(
        overflow.content,
        `${tab} overflows at ${viewport.width}x${viewport.height}; offenders: ${overflow.offenders.join(', ')}`,
      ).toBeLessThanOrEqual(overflow.viewport)
      if (tab === 'play') {
        const boundedControls = await page.locator('.ttmc-all-packs, .pack-options label, .preset-picker, .preset-actions button').evaluateAll(
          (elements) => elements.map((element) => ({
            width: element.clientWidth,
            content: element.scrollWidth,
            text: element.textContent?.trim(),
          })),
        )
        for (const control of boundedControls) {
          expect.soft(control.content, `${control.text} overflows its own control`).toBeLessThanOrEqual(control.width)
        }
      }
    }
  }
})

test('emits no console errors and leaves no browser-stored secrets', async ({ page, context }) => {
  await startQuestion(page)
  await page.getByRole('spinbutton', { name: 'Team A answer' }).fill('40')
  await page.getByRole('spinbutton', { name: 'Team B answer' }).fill('42')
  await page.getByRole('button', { name: 'Lock both answers' }).click()

  const storage = await page.evaluate(async () => ({
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage),
    cookie: document.cookie,
    databases: 'databases' in indexedDB ? await indexedDB.databases() : [],
  }))
  expect(storage).toEqual({ local: [], session: [], cookie: '', databases: [] })
  const cachedUrls = await page.evaluate(async () => {
    const requests = await Promise.all((await caches.keys()).map(async (name) => {
      return (await (await caches.open(name)).keys()).map((request) => request.url)
    }))
    return requests.flat()
  })
  expect(cachedUrls.every((url) => {
    const pathname = new URL(url).pathname
    return pathname === '/' || pathname === '/manifest.webmanifest' || pathname === '/icon.svg' ||
      pathname === '/icon-maskable.svg' || pathname.startsWith('/assets/')
  })).toBe(true)
  expect(await context.cookies()).toEqual([])
  await expect(page.locator('body')).not.toContainText(/sessionId|partyCode|grooop=|secret-session|reauth\.owner@example\.com/i)
})
