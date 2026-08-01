import { accountSecrets } from './accounts'
import { decrypt, sha256 } from './crypto'
import type { Env } from './env'
import { HttpError, json, readJson } from './http'
import { type JsonObject, type SocketFrame, SharedState } from './shared-state'

interface MatchRow {
  id: string
  status: string
  host_account_id: string
  guest_account_id: string
  team_a_json: string
  team_b_json: string
  content_slug: string
  party_code_ciphertext: string | null
  party_code_nonce: string | null
  party_code_key_version: string | null
  game_id: number | null
  game_mode: 'proximo' | 'ttmc'
  rounds: number | null
}

interface PendingRequest {
  id: string
  application: number | null
  type: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

const LIVE_STATUSES = new Set(['waiting', 'playing', 'revealed'])
const SHARED_STATE_TIMEOUT_MS = 5_000
const MAX_RECONNECT_ATTEMPTS = 5
const MAX_RECONNECT_DELAY_MS = 10_000
const PROXIMO_ADD_REQUESTED_KEY = 'proximoAddRequested'
const QUESTION_TIMING_KEY = 'questionTiming'
const FINISH_ACTION_KEY = 'finishAction'
const CANCEL_ACTION_KEY = 'cancelAction'
const TERMINAL_SNAPSHOT_KEY = 'terminalSnapshot'
const TERMINAL_PROJECTION_RETRY_DELAY_MS = 1_000
const PROXIMO_CONTENTS = ['300', '299', 'geographie', 'sciences'] as const
interface StoredAnswerAction {
  answer: number
  status: 'pending' | 'accepted'
}

interface StoredMutationAction {
  status: 'pending' | 'accepted'
}

interface StoredTtmcQuestion {
  raw: JsonObject
  public: JsonObject
}

interface StoredTtmcAnswer extends StoredMutationAction {
  value: unknown
}

interface StoredTtmcStart {
  difficulty: number
}

interface StoredTtmcRoundStart {
  beforeRoundIds: number[]
}

interface StoredProximoAdd {
  beforeGameIds: number[]
}

interface QuestionTiming {
  identity: string
  deadlineAt: number
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null
}

function isTerminalSnapshot(value: unknown, matchId: string): value is Record<string, unknown> {
  const snapshot = asObject(value)
  const party = asObject(snapshot?.party)
  return snapshot?.id === matchId && snapshot.connected === false && (
    (snapshot.status === 'finished' && party?.state === 'finished') || snapshot.status === 'cancelled'
  )
}

export class PartySocket {
  shared = new SharedState()
  private socket: WebSocket | null = null
  private pending: PendingRequest | null = null
  private connecting: Promise<void> | null = null
  private synchronized = false
  private connectionRejection: string | null = null
  private readonly stateListeners = new Set<() => void>()

  constructor(
    private readonly partyCode: string,
    private readonly loadSessionId: () => Promise<string>,
    private readonly changed: () => void,
  ) {}

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN && this.synchronized
  }

  async connect(): Promise<void> {
    if (this.connected) return
    this.connecting ??= this.open().finally(() => { this.connecting = null })
    return this.connecting
  }

  request(application: number | null, type: string, data: unknown): Promise<unknown> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Party socket is not connected')
    if (this.pending) throw new Error('Party socket already has an in-flight request')
    const id = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending = null
        socket.close()
        reject(new Error(`Party request ${type} timed out`))
      }, 10_000)
      this.pending = { id, application, type, resolve, reject, timeout }
      const frame = { a: application, t: type, d: data, u: id }
      try {
        socket.send(JSON.stringify(frame))
      } catch {
        clearTimeout(timeout)
        this.pending = null
        socket.close()
        reject(new Error(`Party request ${type} could not be sent`))
      }
    })
  }

  waitForState<T>(
    predicate: (shared: SharedState) => T | undefined,
    timeoutMs = SHARED_STATE_TIMEOUT_MS,
  ): Promise<T> {
    const current = predicate(this.shared)
    if (current !== undefined) return Promise.resolve(current)

    return new Promise((resolve, reject) => {
      const check = () => {
        const value = predicate(this.shared)
        if (value === undefined) return
        clearTimeout(timeout)
        this.stateListeners.delete(check)
        resolve(value)
      }
      const timeout = setTimeout(() => {
        this.stateListeners.delete(check)
        reject(new Error('Party shared state timed out'))
      }, timeoutMs)
      this.stateListeners.add(check)
      check()
    })
  }

  disconnect(): void {
    this.socket?.close()
  }

  private async open(): Promise<void> {
    this.synchronized = false
    this.connectionRejection = null
    this.shared = new SharedState()
    const sessionId = await this.loadSessionId()
    let response: Response
    try {
      response = await fetch(
        `https://server.grooop.io/ws/party/${encodeURIComponent(this.partyCode)}?bearer=${encodeURIComponent(sessionId)}`,
        { headers: { Upgrade: 'websocket' } },
      )
    } catch (error) {
      const detail = error instanceof Error && /^[a-z0-9 .,:()'/-]{1,160}$/i.test(error.message)
        ? error.message
        : 'unknown transport error'
      throw new HttpError(502, 'party-socket-connect-failed', `Grooop party connection failed: ${detail}`)
    }
    const socket = response.webSocket
    if (!socket) {
      console.warn('Grooop did not accept a party socket upgrade', { status: response.status })
      throw new HttpError(502, 'party-socket-upgrade-rejected', 'Grooop rejected the party socket upgrade')
    }
    socket.accept()
    this.socket = socket
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return
      if (typeof event.data !== 'string') {
        console.error('Party socket returned a binary frame')
        socket.close()
        return
      }
      this.handleMessage(event.data)
    })
    socket.addEventListener('error', () => {
      if (this.socket === socket) {
        console.error('Party socket failed')
      }
    })
    socket.addEventListener('close', (event) => this.handleClose(socket, event))

    try {
      if (await this.request(null, '@SE', null) !== '@OK') {
        throw new Error('Party socket synchronization was rejected')
      }
      this.synchronized = true
      this.changed()
    } catch (error) {
      if (this.socket === socket) socket.close()
      if (error instanceof HttpError) throw error
      const detail = error instanceof Error && /^[a-z0-9 .,:()'@/-]{1,160}$/i.test(error.message)
        ? error.message
        : 'unknown synchronization error'
      throw new HttpError(502, 'party-socket-synchronize-failed', `Grooop party synchronization failed: ${detail}`)
    }
  }

  private connectionError(event?: CloseEvent): HttpError {
    if (this.connectionRejection) {
      console.warn('Grooop rejected a party socket connection', { reason: this.connectionRejection })
      return new HttpError(
        502,
        'party-socket-rejected',
        `Grooop rejected the party connection: ${this.connectionRejection}`,
      )
    }
    const detail = event ? ` (close code ${event.code})` : ''
    return new HttpError(502, 'party-socket-connect-failed', `Grooop party connection failed${detail}`)
  }

  private handleMessage(data: string): void {
    if (data.startsWith('@P-')) {
      const socket = this.socket
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        console.error('Party socket cannot echo a heartbeat while closed')
        socket?.close()
        return
      }
      try {
        socket.send(data)
      } catch {
        console.error('Party socket failed to echo a heartbeat')
        socket.close()
      }
      return
    }
    if (data.startsWith('@CE')) {
      const reason = data.slice(3).trim()
      this.connectionRejection = /^[a-z0-9-]{1,64}$/i.test(reason) ? reason : 'unknown'
      this.socket?.close()
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      console.error('Party socket returned malformed JSON')
      this.socket?.close()
      return
    }
    const parsedFrame = asObject(parsed)
    if (!parsedFrame) {
      console.error('Party socket returned a malformed protocol frame')
      this.socket?.close()
      return
    }
    const frame = parsedFrame as SocketFrame
    if (typeof frame.t !== 'string') {
      console.error('Party socket returned a malformed protocol frame')
      this.socket?.close()
      return
    }
    if (frame.t === '@CLOSE') {
      this.socket?.close()
      return
    }
    if (frame.t === '@SO' || frame.t === '@SL') {
      if (!this.shared.apply(frame)) {
        console.error('Party socket returned a rejected shared-state update')
        this.socket?.close()
        return
      }
      this.changed()
      for (const listener of this.stateListeners) listener()
    }
    const pending = this.pending
    if (pending && frame.u === pending.id) {
      if (
        frame.a !== pending.application ||
        frame.t !== pending.type ||
        !Object.hasOwn(frame, 'd')
      ) {
        console.error('Party socket returned a malformed correlated response')
        this.socket?.close()
        return
      }
      this.pending = null
      clearTimeout(pending.timeout)
      pending.resolve(frame.d)
    }
  }

  private handleClose(socket: WebSocket, event: CloseEvent): void {
    if (this.socket !== socket) return
    const wasSynchronized = this.synchronized
    this.socket = null
    this.synchronized = false
    if (this.pending) {
      clearTimeout(this.pending.timeout)
      this.pending.reject(wasSynchronized ? new Error('Party socket closed') : this.connectionError(event))
      this.pending = null
    }
    this.changed()
  }
}

export class MatchRoom implements DurableObject {
  private match: MatchRow | null = null
  private host: PartySocket | null = null
  private guest: PartySocket | null = null
  private initializing: Promise<void> | null = null
  private publishing = Promise.resolve()
  private lastQuestionFingerprint: string | null = null
  private expectedPlayerIds: readonly number[] = []
  private commands = Promise.resolve()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnecting: Promise<void> | null = null
  private reconnectAttempts = 0
  private questionTiming: QuestionTiming | null = null
  private observedQuestionIdentity: string | null = null
  private acceptQuestionTransitions = false
  private readonly ttmcQuestions = new Map<string, StoredTtmcQuestion>()
  private readonly ttmcDifficulties = new Map<string, number>()
  private readonly ttmcSubmitted = new Set<string>()
  private ttmcRecovering: Promise<void> | null = null
  private terminalSnapshot: Record<string, unknown> | null = null
  private cancelling = false

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/internal/initialize' && request.method === 'POST') {
      const { matchId } = await readJson(request) as { matchId?: unknown }
      if (typeof matchId !== 'string' || !/^[a-f0-9-]{36}$/.test(matchId)) {
        throw new HttpError(400, 'invalid-match-id', 'Match ID is invalid')
      }
      const storedId = await this.state.storage.get<string>('matchId')
      if (storedId && storedId !== matchId) {
        console.error('Durable match room was initialized with a different match ID')
        throw new HttpError(409, 'match-room-already-bound', 'Match room is already initialized')
      }
      await this.state.storage.put('matchId', matchId)
      try {
        await this.ensureConnected()
        return json({ status: 'connected' })
      } catch (error) {
        if (error instanceof HttpError) {
          return json({ error: error.code, message: error.message }, { status: error.status })
        }
        console.error('Match room initialization failed')
        return json({ error: 'match-room-initialize-failed', message: 'The match room could not connect' }, { status: 500 })
      }
    }
    if (url.pathname === '/internal/cancel' && request.method === 'POST') {
      try {
        await this.runCancellation()
        return json({ status: 'cancelled' })
      } catch (error) {
        if (error instanceof HttpError) {
          return json({ error: error.code, message: error.message }, { status: error.status })
        }
        console.error('Match cancellation failed', error)
        return json({ error: 'match-cancel-failed', message: 'The match could not be cancelled' }, { status: 500 })
      }
    }
    if (url.pathname.endsWith('/state')) {
      await this.ensureConnected()
      await this.syncQuestionTiming()
      return json({ match: this.snapshot() })
    }
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return json({ error: 'websocket-required', message: 'Expected a WebSocket upgrade' }, { status: 426 })
    }

    await this.ensureConnected()
    await this.syncQuestionTiming()
    const pair = new WebSocketPair()
    this.state.acceptWebSocket(pair[1])
    pair[1].send(JSON.stringify({ type: 'state', match: this.snapshot() }))
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (message === 'ping') {
      socket.send(JSON.stringify({ type: 'pong' }))
      return
    }
    if (typeof message !== 'string') {
      socket.send(JSON.stringify({ type: 'action-error', error: 'text-frame-required' }))
      return
    }
    let command: JsonObject | null = null
    try {
      command = asObject(JSON.parse(message))
      if (!command) throw new HttpError(400, 'invalid-action', 'Action is invalid')
      const result = await this.runCommand(command)
      socket.send(JSON.stringify({ type: 'action-result', actionId: command.actionId ?? null, result }))
    } catch (error) {
      const known = error instanceof HttpError
      socket.send(JSON.stringify({
        type: 'action-error',
        actionId: command?.actionId ?? null,
        error: known ? error.code : 'match-action-failed',
        message: known ? error.message : 'Match action failed',
      }))
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.commands.then(operation)
    this.commands = result.then(() => undefined, () => undefined)
    return result
  }

  private runCommand(command: JsonObject): Promise<unknown> {
    return this.enqueue(() => this.handleCommand(command))
  }

  private runCancellation(): Promise<void> {
    return this.enqueue(() => this.cancel())
  }

  private async ensureConnected(): Promise<void> {
    if (this.terminalSnapshot) return
    if (this.host && this.guest) {
      const reconnecting = !this.host.connected || !this.guest.connected
      if (reconnecting) this.acceptQuestionTransitions = false
      await Promise.all([this.host.connect(), this.guest.connect()])
      if (this.isTtmc()) await this.recoverTtmcState()
      if (reconnecting) {
        await this.syncQuestionTiming()
        this.acceptQuestionTransitions = true
      }
      this.reconnectAttempts = 0
      return
    }
    this.initializing ??= this.initialize().finally(() => { this.initializing = null })
    return this.initializing
  }

  private async initialize(): Promise<void> {
    const matchId = await this.state.storage.get<string>('matchId')
    if (!matchId) throw new HttpError(409, 'match-not-initialized', 'Match has not been initialized')
    const terminal = await this.state.storage.get(TERMINAL_SNAPSHOT_KEY)
    if (isTerminalSnapshot(terminal, matchId)) {
      this.terminalSnapshot = terminal
      const match = await this.env.DB.prepare('SELECT * FROM matches WHERE id = ?').bind(matchId).first<MatchRow>()
      if (!match) throw new HttpError(409, 'match-not-live', 'Match is not live')
      this.match = match
      await this.projectTerminal()
      return
    }
    const match = await this.env.DB.prepare('SELECT * FROM matches WHERE id = ?').bind(matchId).first<MatchRow>()
    if (!match) {
      throw new HttpError(409, 'match-not-live', 'Match is not live')
    }
    if (match.status === 'finished') {
      if (!isTerminalSnapshot(terminal, match.id)) {
        console.error('Finished match is missing its terminal snapshot')
        throw new HttpError(409, 'terminal-snapshot-missing', 'Finished match result is unavailable')
      }
      this.match = match
      this.terminalSnapshot = terminal
      return
    }
    if (!LIVE_STATUSES.has(match.status)) {
      throw new HttpError(409, 'match-not-live', 'Match is not live')
    }
    if (!match.party_code_ciphertext || !match.party_code_nonce || !match.party_code_key_version) {
      console.error('Match is missing encrypted party connection data')
      throw new HttpError(409, 'match-connection-data-missing', 'Match cannot connect')
    }
    const [partyCode, host, guest] = await Promise.all([
      decrypt({
        ciphertext: match.party_code_ciphertext,
        nonce: match.party_code_nonce,
        keyVersion: match.party_code_key_version,
      }, this.env),
      accountSecrets(this.env, match.host_account_id),
      accountSecrets(this.env, match.guest_account_id),
    ])
    this.match = match
    const expectedPlayerIds = [host.account.grooop_user_id, guest.account.grooop_user_id]
    if (new Set(expectedPlayerIds).size !== 2 || expectedPlayerIds.some((id) => !Number.isSafeInteger(id))) {
      console.error('Match account rows contain invalid Grooop user IDs')
      throw new HttpError(409, 'match-player-identities-invalid', 'Match player identities are invalid')
    }
    this.expectedPlayerIds = expectedPlayerIds
    this.questionTiming = await this.state.storage.get<QuestionTiming>(QUESTION_TIMING_KEY) ?? null
    this.observedQuestionIdentity = this.questionTiming?.identity ?? null
    if (match.game_mode === 'ttmc') {
      const stored = await this.state.storage.list<StoredTtmcQuestion>({ prefix: 'ttmc:question:' })
      for (const [key, question] of stored) this.ttmcQuestions.set(key.slice('ttmc:question:'.length), question)
      const starts = await this.state.storage.list<StoredTtmcStart>({ prefix: 'ttmc:start:' })
      for (const [key, action] of starts) {
        if (typeof action.difficulty === 'number') this.ttmcDifficulties.set(key.slice('ttmc:start:'.length), action.difficulty + 1)
      }
      const answers = await this.state.storage.list<StoredTtmcAnswer>({ prefix: 'ttmc:answer:' })
      for (const key of answers.keys()) this.ttmcSubmitted.add(key.slice('ttmc:answer:'.length))
    }
    const changed = () => {
      if (!this.cancelling) {
        this.queuePublish()
        this.scheduleReconnect()
      }
    }
    this.host = new PartySocket(
      partyCode,
      () => this.currentSession(match.host_account_id, expectedPlayerIds[0]),
      changed,
    )
    this.guest = new PartySocket(
      partyCode,
      () => this.currentSession(match.guest_account_id, expectedPlayerIds[1]),
      changed,
    )
    await Promise.all([this.host.connect(), this.guest.connect()])
    if (match.game_mode === 'ttmc') await this.recoverTtmcState()
    await this.publishState()
    this.acceptQuestionTransitions = true
  }

  private async currentSession(accountId: string, expectedPlayerId: number): Promise<string> {
    const current = await accountSecrets(this.env, accountId)
    if (current.account.grooop_user_id !== expectedPlayerId) {
      console.error('Live match account identity changed')
      throw new HttpError(409, 'account-identity-changed', 'A live match account identity changed')
    }
    return current.sessionId
  }

  private games(): JsonObject[] {
    return this.host?.shared.list(0, 'games').map(asObject).filter((game): game is JsonObject => game !== null) ?? []
  }

  private isProximoGame(game: JsonObject): boolean {
    return Number.isSafeInteger(game.id) && game.gameName === 'proximo'
  }

  private proximoGameIds(): number[] {
    return this.games().flatMap((game) => this.isProximoGame(game) ? [Number(game.id)] : [])
  }

  private synchronizedGameIds(): number[] {
    return this.games().flatMap((game) => Number.isSafeInteger(game.id) ? [Number(game.id)] : [])
  }

  private synchronizedScores(gameId: number): JsonObject[] {
    const scores: JsonObject[] = []
    const seen = new Set<number>()
    for (const value of this.host?.shared.list(gameId, 'scores') ?? []) {
      const score = asObject(value)
      if (!score || !Number.isSafeInteger(score.id) || seen.has(Number(score.id))) {
        console.warn('Skipping malformed synchronized score')
        continue
      }
      seen.add(Number(score.id))
      scores.push(score)
    }
    return scores
  }

  private scoreForPlayer(gameId: number, playerId: number): JsonObject | null {
    return this.synchronizedScores(gameId).find((score) => score.id === playerId) ?? null
  }

  private currentGameId(): number | null {
    const gameId = this.match?.game_id
    return gameId != null && this.games().some((game) => game.id === gameId && this.isProximoGame(game)) ? gameId : null
  }

  private isTtmc(): boolean { return this.match?.game_mode === 'ttmc' }

  private ttmcRounds(): JsonObject[] {
    return this.host?.shared.list(0, 'rounds').map(asObject)
      .filter((round): round is JsonObject => round?.gameName === 'ttmc-round') ?? []
  }

  private ttmcRound(roundId: number): JsonObject | null {
    const round = this.ttmcRounds().find((candidate) => candidate.id === roundId)
    return round ?? null
  }

  private currentTtmcRound(): { round: JsonObject, index: number } | null {
    const rounds = this.ttmcRounds()
    const roundIds = rounds.map((round) => round.id)
    if (roundIds.some((id) => !Number.isSafeInteger(id)) || new Set(roundIds).size !== roundIds.length) {
      console.error('TTMC synchronized rounds have ambiguous identities')
      return null
    }
    const running = rounds.flatMap((round, index) => round.state === 'running'
      ? [{ round, index }]
      : [])
    if (running.length > 1) {
      console.error('TTMC synchronized multiple running rounds')
      return null
    }
    if (running.length === 1) return running[0]
    if (rounds.length > 0) return { round: rounds[rounds.length - 1], index: rounds.length - 1 }
    return null
  }

  private ttmcTeam(side: 'a' | 'b'): { playerId: number, socket: PartySocket } {
    if (!this.match || !this.host || !this.guest) throw new HttpError(409, 'match-not-ready', 'Match is not ready')
    const config = JSON.parse(side === 'a' ? this.match.team_a_json : this.match.team_b_json) as { accountId?: string }
    const index = config.accountId === this.match.host_account_id ? 0 : config.accountId === this.match.guest_account_id ? 1 : -1
    if (index < 0) {
      console.error('TTMC team is not bound to either synchronized account')
      throw new HttpError(409, 'team-account-invalid', 'Team account is invalid')
    }
    return { playerId: this.expectedPlayerIds[index], socket: index === 0 ? this.host : this.guest }
  }

  private ttmcQuestionKey(roundId: number, playerId: number): string { return `${roundId}:${playerId}` }

  private ttmcActionKey(kind: string, roundId: number, playerId?: number): string {
    return `ttmc:${kind}:${roundId}${playerId == null ? '' : `:${playerId}`}`
  }

  private ttmcScore(socket: PartySocket, roundId: number, playerId: number): JsonObject | null {
    return socket.shared.list(roundId, 'scores').map(asObject)
      .find((score): score is JsonObject => score !== null && Number(score.id) === playerId) ?? null
  }

  private gameState(gameId: number): JsonObject {
    return this.games().find((game) => game.id === gameId) ?? {}
  }

  private snapshot(): Record<string, unknown> {
    if (this.terminalSnapshot) return this.terminalSnapshot
    if (!this.match || !this.host || !this.guest) throw new Error('Match room snapshot requested before initialization')
    const party = asObject(this.host.shared.get(0, 'party')) ?? {}
    const players: Array<{ id: number, isConnected: boolean, isGameMaster: boolean, score: number }> = []
    const playerIds = new Set<number>()
    for (const value of this.host.shared.list(0, 'players')) {
      const player = asObject(value)
      if (
        !player || !Number.isSafeInteger(player.id) || playerIds.has(Number(player.id)) ||
        (player.score !== undefined && (typeof player.score !== 'number' || !Number.isFinite(player.score))) ||
        (player.isConnected !== undefined && typeof player.isConnected !== 'boolean') ||
        (player.isGameMaster !== undefined && typeof player.isGameMaster !== 'boolean')
      ) {
        console.warn('Skipping malformed synchronized player')
        continue
      }
      playerIds.add(Number(player.id))
      players.push({
        id: Number(player.id),
        isConnected: player.isConnected === true,
        isGameMaster: player.isGameMaster === true,
        score: typeof player.score === 'number' ? player.score : 0,
      })
    }
    if (this.isTtmc()) return this.ttmcSnapshot(party, players)
    const gameId = this.currentGameId()
    const game = gameId == null ? null : this.gameState(gameId)
    const scores = gameId == null ? [] : this.synchronizedScores(gameId).filter((score) => {
      const validNumber = (value: unknown) => value === undefined || value === null || (typeof value === 'number' && Number.isFinite(value))
      const valid = (score.isReady === undefined || typeof score.isReady === 'boolean')
        && validNumber(score.answer)
        && validNumber(score.answerDelta)
        && validNumber(score.delta)
      if (!valid) console.warn('Skipping malformed synchronized score')
      return valid
    })
    const revealed = game?.showAnswer === true
    const timingIdentity = gameId !== null && Number.isSafeInteger(game?.currentRound) && typeof game?.question === 'string'
      ? `${gameId}:${String(game.currentRound)}:${game.question}`
      : null
    return {
      id: this.match.id,
      status: this.match.status,
      party: { state: typeof party.state === 'string' ? party.state : 'unknown', playerCount: players.length },
      players: players.map((player) => ({ ...player, score: revealed ? player.score : null })),
      teams: { a: JSON.parse(this.match.team_a_json), b: JSON.parse(this.match.team_b_json) },
      gameMode: 'proximo',
      game: gameId == null ? null : {
        id: gameId,
        state: game?.state ?? null,
        currentRound: game?.currentRound ?? null,
        questionDurationSeconds: game?.questionDurationSeconds ?? null,
        questionDeadlineAt: timingIdentity !== null && this.questionTiming?.identity === timingIdentity
          ? this.questionTiming.deadlineAt
          : null,
        category: game?.category ?? null,
        question: game?.question ?? null,
        showAnswer: revealed,
        answer: revealed ? game?.answer ?? null : null,
        scores: scores.map((score) => ({
          id: score.id,
          isReady: score.isReady === true,
          submitted: score.answer !== null && score.answer !== undefined,
          answer: revealed ? score.answer ?? null : null,
          delta: revealed ? score.answerDelta ?? score.delta ?? null : null,
        })),
      },
      connected: this.host.connected && this.guest.connected,
    }
  }

  private ttmcSnapshot(party: JsonObject, players: JsonObject[]): Record<string, unknown> {
    const current = this.currentTtmcRound()
    const revealScores = party.state === 'finished' || current?.round.state === 'finished'
    const publicPlayers = players.map((player) => ({ ...player, score: revealScores ? player.score : null }))
    return {
      id: this.match!.id,
      status: this.match!.status,
      party: { state: typeof party.state === 'string' ? party.state : 'unknown', playerCount: players.length },
      players: publicPlayers,
      teams: { a: JSON.parse(this.match!.team_a_json), b: JSON.parse(this.match!.team_b_json) },
      gameMode: 'ttmc',
      game: current ? this.publicTtmcRound(current.round, current.index) : null,
      connected: this.host!.connected && this.guest!.connected,
    }
  }

  private publicTtmcRound(round: JsonObject, index: number): Record<string, unknown> | null {
    const roundId = Number(round.id)
    if (!Number.isSafeInteger(roundId) || round.gameName !== 'ttmc-round') {
      console.error('TTMC current round has an invalid identity')
      return null
    }
    const finished = round.state === 'finished'
    const played = Array.isArray(round.played)
      ? new Set(round.played.filter((playerId): playerId is number => Number.isSafeInteger(playerId)))
      : new Set<number>()
    const scores = this.synchronizedScores(roundId)
    const publicTeam = (side: 'a' | 'b') => {
      const { playerId } = this.ttmcTeam(side)
      const key = this.ttmcQuestionKey(roundId, playerId)
      const question = this.ttmcQuestions.get(key)
      const score = scores.find((candidate) => Number(candidate.id) === playerId)
      return {
        difficulty: typeof score?.difficulty === 'number' ? score.difficulty + 1 : this.ttmcDifficulties.get(key) ?? null,
        submitted: played.has(playerId) || this.ttmcSubmitted.has(key),
        success: finished && typeof score?.success === 'boolean' ? score.success : null,
        points: finished && typeof score?.points === 'number' ? score.points : null,
        question: question?.public ?? null,
        officialAnswer: finished ? this.officialTtmcAnswer(question?.raw) : null,
      }
    }
    return {
      mode: 'ttmc',
      id: roundId,
      roundNumber: index + 1,
      totalRounds: this.match?.rounds ?? (Number.isSafeInteger(round.total) ? round.total : index + 1),
      state: typeof round.state === 'string' ? round.state : 'unknown',
      category: typeof round.category === 'string' ? round.category : null,
      title: typeof round.title === 'string' ? round.title : null,
      teams: { a: publicTeam('a'), b: publicTeam('b') },
    }
  }

  private queuePublish(): void {
    this.publishing = this.publishing.then(() => this.publishState()).catch(() => {
      console.error('Failed to publish live match state')
      this.broadcast({ type: 'connection', connected: false })
    })
  }

  private scheduleReconnect(): void {
    if (
      this.reconnectTimer || this.reconnecting || !this.match || !LIVE_STATUSES.has(this.match.status) ||
      !this.host || !this.guest || (this.host.connected && this.guest.connected) ||
      this.state.getWebSockets().length === 0
    ) return
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.warn('Upstream reconnect limit reached; a later client action can retry')
      return
    }

    const delay = Math.min(500 * 2 ** this.reconnectAttempts, MAX_RECONNECT_DELAY_MS)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (
        !this.match || !LIVE_STATUSES.has(this.match.status) || this.state.getWebSockets().length === 0 ||
        !this.host || !this.guest || (this.host.connected && this.guest.connected)
      ) return
      this.reconnectAttempts += 1
      this.acceptQuestionTransitions = false
      this.reconnecting = Promise.all([this.host.connect(), this.guest.connect()])
        .then(async () => {
          if (this.isTtmc()) await this.recoverTtmcState()
          await this.syncQuestionTiming()
          this.acceptQuestionTransitions = true
          this.reconnectAttempts = 0
          return this.publishState()
        })
        .catch(() => {
          console.warn('Upstream reconnect attempt failed')
        })
        .finally(() => {
          this.reconnecting = null
          this.scheduleReconnect()
        })
    }, delay)
  }

  private stopReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private async requireSynchronizedPlayers(host: PartySocket): Promise<void> {
    try {
      await host.waitForState((shared) => {
        const playerIds = new Set(shared.list(0, 'players').map(asObject)
          .filter((player): player is JsonObject => player !== null)
          .map((player) => Number(player.id)))
        return this.expectedPlayerIds.every((id) => playerIds.has(id)) ? true : undefined
      })
    } catch {
      console.warn('Expected match players were not present in synchronized party state')
      throw new HttpError(409, 'match-players-not-synchronized', 'Match players are not synchronized')
    }
  }

  private async persistGameId(gameId: number): Promise<void> {
    const match = this.match
    if (!match) {
      console.error('Cannot persist a game without an initialized match')
      throw new HttpError(409, 'match-not-ready', 'Match is not ready')
    }
    if (match.game_id === gameId) return
    await this.env.DB.prepare('UPDATE matches SET game_id = ?, updated_at = ? WHERE id = ?')
      .bind(gameId, new Date().toISOString(), match.id).run()
    match.game_id = gameId
    this.questionTiming = null
    await Promise.all([
      this.state.storage.delete(PROXIMO_ADD_REQUESTED_KEY),
      this.state.storage.delete(QUESTION_TIMING_KEY),
    ])
  }

  private async resolveGameId(): Promise<number | null> {
    const requested = await this.state.storage.get<StoredProximoAdd>(PROXIMO_ADD_REQUESTED_KEY)
    const ids = requested
      ? this.proximoGameIds().filter((id) => !requested.beforeGameIds.includes(id))
      : []
    if (ids.length > 1) {
      console.warn('Multiple new Proximo games appeared in synchronized party state')
      throw new HttpError(409, 'multiple-proximo-games', 'Multiple new Proximo games appeared')
    }
    if (ids.length === 1) {
      await this.persistGameId(ids[0])
      return ids[0]
    }
    if (requested) {
      throw new HttpError(409, 'proximo-add-pending', 'A previous Proximo add request is still pending')
    }
    const current = this.currentGameId()
    if (current !== null) return current
    const namedIds = this.proximoGameIds()
    if (namedIds.length > 1) {
      console.warn('Multiple Proximo games exist without a persisted current game')
      throw new HttpError(409, 'multiple-proximo-games', 'Current Proximo game is ambiguous')
    }
    if (namedIds.length === 0) return null
    await this.persistGameId(namedIds[0])
    return namedIds[0]
  }

  private async waitForAddedProximo(host: PartySocket, beforeGameIds: readonly number[]): Promise<number> {
    try {
      return await host.waitForState(() => {
        const ids = this.proximoGameIds().filter((id) => !beforeGameIds.includes(id))
        return ids.length === 1 ? ids[0] : undefined
      })
    } catch {
      const ids = this.proximoGameIds().filter((id) => !beforeGameIds.includes(id))
      if (ids.length > 1) {
        console.warn('Added Proximo produced multiple identifiable games')
        throw new HttpError(502, 'multiple-proximo-games', 'Proximo produced multiple games')
      }
      console.warn('Added Proximo did not produce one synchronized game in time')
      throw new HttpError(502, 'game-id-missing', 'Proximo started without an identifiable game')
    }
  }

  private answerActionKey(gameId: number, round: string | number, playerId: number): string {
    return `answer:${gameId}:${String(round)}:${playerId}`
  }

  private readyActionKey(gameId: number, playerId: number): string {
    return `ready:${gameId}:${playerId}`
  }

  private async submitAnswer(
    socket: PartySocket,
    actionKey: string,
    gameId: number,
    answer: number,
    synchronizedAnswer: unknown,
  ): Promise<unknown> {
    const stored = await this.state.storage.get<StoredAnswerAction>(actionKey)
    if (stored) {
      if (stored.answer !== answer) {
        console.warn('Answer retry conflicts with the persisted answer')
        throw new HttpError(409, 'answer-conflict', 'A different answer is already locked')
      }
      if (stored.status === 'pending') {
        if (synchronizedAnswer === null || synchronizedAnswer === undefined) {
          throw new HttpError(409, 'answer-outcome-unknown', 'A previous answer is awaiting reconciliation')
        }
        if (Number(synchronizedAnswer) !== answer) {
          console.warn('Pending answer conflicts with the synchronized answer')
          throw new HttpError(409, 'answer-conflict', 'A different answer is already locked')
        }
        await this.state.storage.put(actionKey, { answer, status: 'accepted' } satisfies StoredAnswerAction)
      }
      return 'already-submitted'
    }
    if (synchronizedAnswer !== null && synchronizedAnswer !== undefined) {
      if (Number(synchronizedAnswer) !== answer) {
        console.warn('Answer retry conflicts with the synchronized answer')
        throw new HttpError(409, 'answer-conflict', 'A different answer is already locked')
      }
      await this.state.storage.put(actionKey, { answer, status: 'accepted' } satisfies StoredAnswerAction)
      return 'already-submitted'
    }

    await this.state.storage.put(actionKey, { answer, status: 'pending' } satisfies StoredAnswerAction)
    const upstreamResult = await socket.request(gameId, 'answer', answer)
    const response = asObject(upstreamResult)
    const accepted = response
      && typeof response.answer === 'number' && Number.isFinite(response.answer)
      && typeof response.delta === 'number' && Number.isFinite(response.delta)
    if (!accepted) {
      if (upstreamResult === false) {
        await this.state.storage.delete(actionKey)
        throw new HttpError(502, 'answer-rejected', 'The answer was rejected')
      }
      console.warn('Proximo answer returned an ambiguous response')
      throw new HttpError(409, 'answer-outcome-unknown', 'The answer is awaiting reconciliation')
    }
    await this.state.storage.put(actionKey, { answer, status: 'accepted' } satisfies StoredAnswerAction)
    return 'accepted'
  }

  private async markReady(
    socket: PartySocket,
    gameId: number,
    playerId: number,
    synchronizedReady: boolean,
  ): Promise<string> {
    const actionKey = this.readyActionKey(gameId, playerId)
    const stored = await this.state.storage.get<StoredMutationAction>(actionKey)
    if (synchronizedReady) {
      if (stored?.status !== 'accepted') {
        await this.state.storage.put(actionKey, { status: 'accepted' } satisfies StoredMutationAction)
      }
      return 'ok'
    }
    if (stored) {
      throw new HttpError(409, 'ready-outcome-unknown', 'A previous ready action is awaiting reconciliation')
    }
    await this.state.storage.put(actionKey, { status: 'pending' } satisfies StoredMutationAction)
    const result = await socket.request(gameId, 'ready', null)
    if (result !== 'ok') {
      if (typeof result === 'string' || result === false) {
        await this.state.storage.delete(actionKey)
        throw new HttpError(502, 'ready-rejected', 'A team was not accepted as ready')
      }
      console.warn('Proximo ready returned an ambiguous response')
      throw new HttpError(409, 'ready-outcome-unknown', 'The ready action is awaiting reconciliation')
    }
    await this.state.storage.put(actionKey, { status: 'accepted' } satisfies StoredMutationAction)
    return result
  }

  private contentSlugs(): string[] {
    const content = this.match?.content_slug
    if (content === 'all') return [...PROXIMO_CONTENTS]
    if (content && (PROXIMO_CONTENTS as readonly string[]).includes(content)) return [content]
    console.error('Proximo match has invalid content configuration')
    throw new HttpError(500, 'match-data-invalid', 'Match data is invalid')
  }

  private async addProximo(host: PartySocket): Promise<unknown> {
    const contents = this.contentSlugs()
    const beforeGameIds = this.synchronizedGameIds()
    await this.state.storage.put(PROXIMO_ADD_REQUESTED_KEY, { beforeGameIds } satisfies StoredProximoAdd)
    const result = await host.request(0, 'add-game', {
      gameName: 'proximo', config: { contents },
    })
    if (result !== 'success') {
      console.warn('Proximo add-game returned an ambiguous response')
      throw new HttpError(409, 'proximo-add-outcome-unknown', 'The Proximo game is awaiting reconciliation')
    }
    await this.persistGameId(await this.waitForAddedProximo(host, beforeGameIds))
    await this.publishState()
    return result
  }

  private async submitTeamAnswer(
    teamSide: 'a' | 'b',
    answer: number,
    gameId: number,
    currentRound: number,
  ): Promise<unknown> {
    const { match, host, guest } = this
    if (!match || !host || !guest) throw new HttpError(409, 'match-not-ready', 'Match is not ready')
    const team = JSON.parse(teamSide === 'a' ? match.team_a_json : match.team_b_json) as { accountId?: string }
    const isHost = team.accountId === match.host_account_id
    if (!isHost && team.accountId !== match.guest_account_id) {
      console.warn('Match team is not bound to either synchronized account')
      throw new HttpError(409, 'team-account-invalid', 'Team account is invalid')
    }
    const playerId = this.expectedPlayerIds[isHost ? 0 : 1]
    const score = this.scoreForPlayer(gameId, playerId)
    if (!score) {
      console.warn('Answer command received before the synchronized player score was available')
      throw new HttpError(409, 'game-score-not-synchronized', 'Game score is not synchronized')
    }
    const actionKey = this.answerActionKey(gameId, currentRound, playerId)
    return this.submitAnswer(
      isHost ? host : guest,
      actionKey,
      gameId,
      answer,
      score.answer,
    )
  }

  private async syncQuestionTiming(): Promise<void> {
    // Keep a restored deadline while @SE is still rebuilding authoritative state.
    if (!this.host?.connected) return
    const gameId = this.currentGameId()
    const game = gameId === null ? null : this.gameState(gameId)
    const revealed = game?.showAnswer === true
    const round = game?.currentRound
    const question = game?.question
    const duration = game?.questionDurationSeconds
    const active = !revealed
      && typeof round === 'number'
      && Number.isSafeInteger(round)
      && round >= 0
      && typeof question === 'string'
      && question.length > 0
      && Number.isFinite(duration)
      && Number(duration) > 0
    if (revealed) {
      if (this.questionTiming) {
        this.questionTiming = null
        await this.state.storage.delete(QUESTION_TIMING_KEY)
      }
      return
    }
    if (!active || gameId === null) return
    const identity = `${gameId}:${String(round)}:${question}`
    if (this.questionTiming?.identity === identity) {
      this.observedQuestionIdentity = identity
      return
    }
    if (this.observedQuestionIdentity === identity) return
    if (!this.acceptQuestionTransitions) {
      console.warn('Refusing to create a deadline for a question first discovered during synchronization')
      this.observedQuestionIdentity = identity
      if (this.questionTiming) {
        this.questionTiming = null
        await this.state.storage.delete(QUESTION_TIMING_KEY)
      }
      return
    }
    const timing = { identity, deadlineAt: Date.now() + Number(duration) * 1_000 }
    await this.state.storage.put(QUESTION_TIMING_KEY, timing)
    this.questionTiming = timing
    this.observedQuestionIdentity = identity
  }

  private async projectTerminal(): Promise<boolean> {
    const match = this.match
    const status = this.terminalSnapshot?.status
    if (!match || (status !== 'finished' && status !== 'cancelled')) {
      console.error('Cannot project a terminal snapshot without an initialized match')
      return false
    }
    try {
      if (match.status !== status) {
        const now = new Date().toISOString()
        await this.env.DB.prepare('UPDATE matches SET status = ?, finished_at = ?, updated_at = ? WHERE id = ?')
          .bind(status, now, now, match.id).run()
        match.status = status
      }
      if (status === 'cancelled') await this.state.storage.delete(CANCEL_ACTION_KEY)
      return true
    } catch (error) {
      console.error('Failed to project terminal snapshot to D1', error)
      await this.state.storage.setAlarm(Date.now() + TERMINAL_PROJECTION_RETRY_DELAY_MS)
      return false
    }
  }

  private async complete(snapshot: Record<string, unknown>): Promise<boolean> {
    const match = this.match
    if (!match || !isTerminalSnapshot(snapshot, match.id)) {
      console.error('Refusing to persist an invalid terminal snapshot')
      throw new HttpError(409, 'terminal-snapshot-invalid', 'Match result is invalid')
    }
    await this.state.storage.put(TERMINAL_SNAPSHOT_KEY, snapshot)
    this.terminalSnapshot = snapshot
    this.stopReconnect()
    return this.projectTerminal()
  }

  private resumeLiveState(): void {
    this.cancelling = false
    this.queuePublish()
    this.scheduleReconnect()
  }

  private async cancel(): Promise<void> {
    await this.ensureConnected()
    if (this.terminalSnapshot?.status === 'cancelled') {
      if (!await this.projectTerminal()) {
        throw new HttpError(503, 'match-cancel-finalizing', 'Match cancellation is still being saved')
      }
      return
    }
    const { match, host, guest } = this
    if (!match || !host || !guest || !LIVE_STATUSES.has(match.status)) {
      throw new HttpError(409, 'match-not-cancellable', 'This match cannot be cancelled')
    }
    const stored = await this.state.storage.get<StoredMutationAction>(CANCEL_ACTION_KEY)
    if (stored) {
      throw new HttpError(409, 'match-cancel-outcome-unknown', 'A previous cancellation is awaiting reconciliation')
    }

    const party = asObject(host.shared.get(0, 'party'))
    if (party?.state === 'waiting') {
      if (this.isTtmc() && this.ttmcRounds().length === 0) {
        await this.startTtmcRound(host, 'ttmc:next:initial')
      } else if (!this.isTtmc() && await this.resolveGameId() === null) {
        await this.addProximo(host)
      }
    }

    await this.state.storage.put(CANCEL_ACTION_KEY, { status: 'pending' } satisfies StoredMutationAction)
    this.cancelling = true
    let result: unknown
    try {
      result = await guest.request(0, 'give-up', undefined)
    } catch {
      this.resumeLiveState()
      throw new HttpError(409, 'match-cancel-outcome-unknown', 'The cancellation is awaiting reconciliation')
    }
    if (result !== 'ok') {
      if (typeof result === 'string' || result === false) {
        console.warn('Grooop rejected match cancellation', { result })
        await this.state.storage.delete(CANCEL_ACTION_KEY)
        this.resumeLiveState()
        throw new HttpError(502, 'match-cancel-rejected', 'The match could not be cancelled')
      }
      this.resumeLiveState()
      throw new HttpError(409, 'match-cancel-outcome-unknown', 'The cancellation is awaiting reconciliation')
    }

    const snapshot = this.snapshot()
    snapshot.status = 'cancelled'
    snapshot.connected = false
    let projected: boolean
    try {
      projected = await this.complete(snapshot)
    } catch {
      this.resumeLiveState()
      throw new HttpError(409, 'match-cancel-outcome-unknown', 'The cancellation is awaiting reconciliation')
    }
    host.disconnect()
    guest.disconnect()
    this.broadcast({ type: 'state', match: snapshot })
    this.cancelling = false
    if (!projected) {
      throw new HttpError(503, 'match-cancel-finalizing', 'Match cancellation is still being saved')
    }
  }

  private async publishState(): Promise<void> {
    if (this.terminalSnapshot) {
      this.broadcast({ type: 'state', match: this.terminalSnapshot })
      return
    }
    if (!this.match) return
    await this.syncQuestionTiming()
    const snapshot = this.snapshot()
    const party = asObject(snapshot.party)
    if (party?.state === 'finished' && this.match.status !== 'finished') {
      snapshot.status = 'finished'
      snapshot.connected = false
      await this.complete(snapshot)
    }
    if (!this.host?.connected || !this.guest?.connected) {
      this.broadcast({ type: 'state', match: snapshot })
      return
    }
    const game = asObject(snapshot.game)
    const status = this.match.status === 'finished' ? 'finished' : this.isTtmc()
      ? this.ttmcRounds().some((round) => round.state === 'running')
        ? 'playing'
        : this.ttmcRounds().some((round) => round.state === 'finished') ? 'revealed' : 'waiting'
      : game?.showAnswer === true ? 'revealed' : game ? 'playing' : 'waiting'
    if (status !== this.match.status) {
      await this.env.DB.prepare('UPDATE matches SET status = ?, updated_at = ? WHERE id = ?')
        .bind(status, new Date().toISOString(), this.match.id).run()
      this.match.status = status
      snapshot.status = status
    }
    if (!this.isTtmc() && game?.showAnswer === true && typeof game.question === 'string' && game.question && game.answer != null) {
      try {
        const answer = String(game.answer)
        const fingerprint = await sha256(`${this.match.content_slug}\n${game.question}\n${answer}`)
        if (fingerprint !== this.lastQuestionFingerprint) {
          await this.env.DB.prepare(
            `INSERT OR IGNORE INTO observed_questions
             (id, fingerprint, content_slug, category, question, answer, first_match_id, first_seen_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            crypto.randomUUID(), fingerprint, this.match.content_slug,
            typeof game.category === 'string' ? game.category : null,
            game.question, answer, this.match.id, new Date().toISOString(),
          ).run()
          this.lastQuestionFingerprint = fingerprint
        }
      } catch {
        console.warn('Failed to archive an observed question')
      }
    }
    this.broadcast({ type: 'state', match: snapshot })
  }

  private officialTtmcAnswer(raw: JsonObject | undefined): unknown {
    const answers = asObject(raw?.answers)
    if (!answers) return null
    if (answers.selected === 'bool') return typeof answers.answer === 'boolean' ? answers.answer ? 'Yes' : 'No' : null
    if (answers.selected === 'qcm' && Array.isArray(answers.answers)) {
      const correct = answers.answers.flatMap((item) => {
        const option = asObject(item)
        return option?.correct === true && typeof option.text === 'string' ? [option.text] : []
      })
      return correct.length ? correct : null
    }
    if (answers.selected === 'words') return typeof answers.correctSentence === 'string' ? answers.correctSentence : null
    if (answers.selected === 'oneword') return typeof answers.theWord === 'string' ? answers.theWord : null
    if (answers.selected === 'number' && typeof answers.correct === 'number' && Number.isFinite(answers.correct) && typeof answers.tolerance === 'number' && Number.isFinite(answers.tolerance)) {
      return { value: answers.correct, tolerance: answers.tolerance }
    }
    return null
  }

  private ttmcNumberStep(correct: number, tolerance: number): number | null {
    if (!Number.isFinite(correct) || !Number.isFinite(tolerance) || tolerance < 0) return null
    if (tolerance > 0 && tolerance < 1) {
      if (tolerance === 0.1) return 0.1
      if (tolerance === 0.01) return 0.01
      return 0.001
    }
    if (Number.isInteger(correct)) return tolerance >= 1_000 ? 100 : tolerance >= 100 ? 10 : 1
    const decimals = String(correct).split('.')[1]?.length ?? 0
    return decimals <= 1 ? 0.1 : decimals === 2 ? 0.01 : 0.001
  }

  private shuffled(values: string[]): string[] {
    const shuffled = [...values]
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const random = crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32
      const swap = Math.floor(random * (index + 1))
      ;[shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]]
    }
    return shuffled
  }

  private publicTtmcQuestion(raw: JsonObject): JsonObject | null {
    const answers = asObject(raw.answers)
    if (typeof raw.question !== 'string' || !answers) return null
    if (answers.selected === 'bool' && typeof answers.answer === 'boolean') return { type: 'bool', prompt: raw.question }
    if (answers.selected === 'qcm' && Array.isArray(answers.answers)) {
      const options: string[] = []
      let selectionCount = 0
      for (const item of answers.answers) {
        const option = asObject(item)
        if (!option || typeof option.text !== 'string' || typeof option.correct !== 'boolean') return null
        options.push(option.text)
        if (option.correct) selectionCount += 1
      }
      if (!options.length || selectionCount < 1) return null
      return { type: 'qcm', prompt: raw.question, options, selectionCount }
    }
    if (answers.selected === 'words' && typeof answers.correctSentence === 'string' && typeof answers.wrongWords === 'string') {
      const correct = answers.correctSentence.trim().split(/\s+/).filter(Boolean)
      const wrong = answers.wrongWords.trim().split(/\s+/).filter(Boolean)
      if (!correct.length) return null
      return { type: 'words', prompt: raw.question, candidates: this.shuffled([...correct, ...wrong]), answerWordCount: correct.length }
    }
    if (answers.selected === 'oneword' && typeof answers.theWord === 'string' && answers.theWord.trim()) {
      return { type: 'oneword', prompt: raw.question }
    }
    if (
      answers.selected === 'number' && typeof answers.correct === 'number' && Number.isFinite(answers.correct) &&
      typeof answers.min === 'number' && Number.isFinite(answers.min) && typeof answers.max === 'number' && Number.isFinite(answers.max) &&
      answers.min <= answers.max && answers.correct >= answers.min && answers.correct <= answers.max &&
      typeof answers.tolerance === 'number' && Number.isFinite(answers.tolerance)
    ) {
      const step = this.ttmcNumberStep(answers.correct, answers.tolerance)
      if (step !== null) return { type: 'number', prompt: raw.question, min: answers.min, max: answers.max, step }
    }
    console.warn('Refusing to expose an unknown TTMC question schema')
    return null
  }

  private normalizeTtmcAnswer(raw: JsonObject, answer: unknown): unknown {
    const answers = asObject(raw.answers)
    if (!answers) throw new HttpError(409, 'ttmc-question-invalid', 'TTMC question data is invalid')
    if (answers.selected === 'bool' && typeof answers.answer === 'boolean' && typeof answer === 'boolean') return answer
    if (answers.selected === 'qcm' && Array.isArray(answers.answers)) {
      const options = answers.answers
      const count = options.filter((item) => asObject(item)?.correct === true).length
      if (
        Array.isArray(answer) && count > 0 && answer.length === count &&
        answer.every((value) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) < options.length) &&
        new Set(answer).size === answer.length
      ) return answer
    }
    if (answers.selected === 'words' && typeof answers.correctSentence === 'string' && typeof answers.wrongWords === 'string' && Array.isArray(answer)) {
      const expectedCount = answers.correctSentence.trim().split(/\s+/).filter(Boolean).length
      const available = [...answers.correctSentence.trim().split(/\s+/), ...answers.wrongWords.trim().split(/\s+/)].filter(Boolean)
      const remaining = new Map<string, number>()
      for (const word of available) remaining.set(word, (remaining.get(word) ?? 0) + 1)
      const valid = answer.length === expectedCount && answer.every((word) => {
        if (typeof word !== 'string' || (remaining.get(word) ?? 0) < 1) return false
        remaining.set(word, remaining.get(word)! - 1)
        return true
      })
      if (valid) return answer
    }
    if (answers.selected === 'oneword' && typeof answers.theWord === 'string' && typeof answer === 'string' && answer.trim()) {
      return answer.trim().toLowerCase()
    }
    if (
      answers.selected === 'number' && typeof answer === 'number' && Number.isFinite(answer) &&
      typeof answers.correct === 'number' && Number.isFinite(answers.correct) && typeof answers.tolerance === 'number' && Number.isFinite(answers.tolerance) &&
      typeof answers.min === 'number' && Number.isFinite(answers.min) && typeof answers.max === 'number' && Number.isFinite(answers.max) &&
      answer >= answers.min && answer <= answers.max
    ) {
      const step = this.ttmcNumberStep(answers.correct, answers.tolerance)
      if (step !== null && Math.abs((answer - answers.min) / step - Math.round((answer - answers.min) / step)) < 1e-7) return answer
    }
    throw new HttpError(400, 'invalid-answers', 'Answer does not match the TTMC question')
  }

  private async storeTtmcQuestion(roundId: number, playerId: number, response: unknown): Promise<StoredTtmcQuestion> {
    const raw = asObject(response)
    const publicQuestion = raw && this.publicTtmcQuestion(raw)
    if (!raw || !publicQuestion) throw new HttpError(502, 'ttmc-question-invalid', 'TTMC returned an unsupported question')
    const question = { raw, public: publicQuestion }
    await this.state.storage.put(`ttmc:question:${this.ttmcQuestionKey(roundId, playerId)}`, question)
    this.ttmcQuestions.set(this.ttmcQuestionKey(roundId, playerId), question)
    return question
  }

  private async loadTtmcQuestion(roundId: number, playerId: number, socket: PartySocket): Promise<StoredTtmcQuestion> {
    const key = this.ttmcQuestionKey(roundId, playerId)
    const existing = this.ttmcQuestions.get(key) ?? await this.state.storage.get<StoredTtmcQuestion>(`ttmc:question:${key}`)
    if (existing) { this.ttmcQuestions.set(key, existing); return existing }
    return this.storeTtmcQuestion(roundId, playerId, await socket.request(roundId, 'get-question', undefined))
  }

  private recoverTtmcState(): Promise<void> {
    this.ttmcRecovering ??= this.doRecoverTtmcState().finally(() => { this.ttmcRecovering = null })
    return this.ttmcRecovering
  }

  private async doRecoverTtmcState(): Promise<void> {
    if (!this.match || !this.host || !this.guest || !this.isTtmc()) return
    const starts = await this.state.storage.list<StoredTtmcStart>({ prefix: 'ttmc:start:' })
    for (const [storageKey, action] of starts) {
      const parsed = storageKey.match(/^ttmc:start:(\d+):(\d+)$/)
      if (!parsed || !Number.isSafeInteger(action.difficulty) || action.difficulty < 0 || action.difficulty > 9) {
        console.error('Stored TTMC start action is invalid')
        continue
      }
      const roundId = Number(parsed[1])
      const playerId = Number(parsed[2])
      const socket = playerId === this.expectedPlayerIds[0] ? this.host : playerId === this.expectedPlayerIds[1] ? this.guest : null
      if (!socket) {
        console.error('Stored TTMC start action has an unknown player')
        continue
      }
      const score = this.ttmcScore(socket, roundId, playerId)
      if (!score) continue
      if (score.difficulty !== action.difficulty) {
        console.error('Stored TTMC difficulty conflicts with synchronized score')
        continue
      }
      await this.loadTtmcQuestion(roundId, playerId, socket)
    }

    const answers = await this.state.storage.list<StoredTtmcAnswer>({ prefix: 'ttmc:answer:' })
    for (const [storageKey, action] of answers) {
      const parsed = storageKey.match(/^ttmc:answer:(\d+):(\d+)$/)
      if (!parsed) {
        console.error('Stored TTMC answer action is invalid')
        continue
      }
      const roundId = Number(parsed[1])
      const playerId = Number(parsed[2])
      const key = this.ttmcQuestionKey(roundId, playerId)
      this.ttmcSubmitted.add(key)
      if (action.status !== 'pending') continue
      const round = this.ttmcRound(roundId)
      const played = Array.isArray(round?.played) && round.played.some((id) => Number(id) === playerId)
      const score = this.scoreForPlayer(roundId, playerId)
      if (played && typeof score?.success === 'boolean') {
        await this.state.storage.put(storageKey, { status: 'accepted', value: action.value } satisfies StoredTtmcAnswer)
      }
    }
  }

  private async startTtmcRound(host: PartySocket, markerKey: string): Promise<string> {
    const marker = await this.state.storage.get<StoredTtmcRoundStart>(markerKey)
    if (marker) {
      if (!Array.isArray(marker.beforeRoundIds) || !marker.beforeRoundIds.every(Number.isSafeInteger)) {
        console.error('Stored TTMC round advance action is invalid')
        throw new HttpError(409, 'round-start-outcome-unknown', 'A previous round start is awaiting reconciliation')
      }
      const before = new Set(marker.beforeRoundIds)
      const newer = this.ttmcRounds().filter((candidate) => Number.isSafeInteger(candidate.id) && !before.has(Number(candidate.id)))
      if (newer.length === 1) return 'already-started'
      if (newer.length > 1) console.error('Multiple TTMC rounds appeared while reconciling a round advance')
      throw new HttpError(409, 'round-start-outcome-unknown', 'A previous round start is awaiting reconciliation')
    }

    if (!this.match?.rounds || this.ttmcRounds().length >= this.match.rounds) {
      throw new HttpError(409, 'ttmc-round-limit-reached', 'All configured TTMC rounds have been created')
    }

    const beforeRoundIds = this.ttmcRounds().flatMap((candidate) => Number.isSafeInteger(candidate.id) ? [Number(candidate.id)] : [])
    await this.state.storage.put(markerKey, { beforeRoundIds } satisfies StoredTtmcRoundStart)
    let result: unknown
    try {
      result = await host.request(0, 'start-round', undefined)
    } catch {
      throw new HttpError(409, 'round-start-outcome-unknown', 'The next round is awaiting reconciliation')
    }
    if (result !== 'success') {
      console.warn('TTMC round start returned an ambiguous response')
      throw new HttpError(409, 'round-start-outcome-unknown', 'The next round is awaiting reconciliation')
    }
    let newer: JsonObject[]
    try {
      newer = await host.waitForState((shared) => {
        const added = shared.list(0, 'rounds').map(asObject)
          .filter((candidate): candidate is JsonObject => candidate !== null && Number.isSafeInteger(candidate.id) && !beforeRoundIds.includes(Number(candidate.id)))
        return added.length ? added : undefined
      })
    } catch {
      throw new HttpError(409, 'round-start-outcome-unknown', 'The next round is awaiting reconciliation')
    }
    if (newer.length !== 1 || newer[0].gameName !== 'ttmc-round') {
      console.error('TTMC produced an invalid number of rounds after start-round')
      throw new HttpError(502, 'multiple-ttmc-rounds', 'TTMC produced an invalid next round')
    }
    await this.publishState()
    return 'success'
  }

  private async handleTtmcCommand(command: JsonObject, host: PartySocket): Promise<unknown> {
    if (command.type !== 'start-ttmc-round' && command.type !== 'start-ttmc-question' && command.type !== 'ttmc-answers' && command.type !== 'next-ttmc-round') {
      throw new HttpError(400, 'unsupported-action', 'Action is not supported for TTMC')
    }
    if (command.type === 'start-ttmc-round') {
      const party = asObject(host.shared.get(0, 'party'))
      if (party?.state !== 'waiting' && party?.state !== 'running') {
        throw new HttpError(409, 'party-not-running', 'The TTMC party is not ready to start')
      }
      if (this.ttmcRounds().length > 0) return 'already-started'
      return this.startTtmcRound(host, 'ttmc:next:initial')
    }
    if (typeof command.roundId !== 'number' || !Number.isSafeInteger(command.roundId)) {
      throw new HttpError(400, 'invalid-round-id', 'Round ID must be an integer')
    }
    const roundId = command.roundId
    if (command.type === 'next-ttmc-round') {
      const markerKey = this.ttmcActionKey('next', roundId)
      if (await this.state.storage.get<StoredTtmcRoundStart>(markerKey)) {
        return this.startTtmcRound(host, markerKey)
      }
    }
    const current = this.currentTtmcRound()
    if (!current || current.round.id !== roundId) {
      throw new HttpError(409, 'round-not-current', 'TTMC round is not the authoritative current round')
    }
    const round = current.round
    const finished = round.state === 'finished'
    if (command.type === 'start-ttmc-question') {
      if (command.side !== 'a' && command.side !== 'b') throw new HttpError(400, 'invalid-side', 'Side must be a or b')
      if (typeof command.difficulty !== 'number' || !Number.isSafeInteger(command.difficulty) || command.difficulty < 0 || command.difficulty > 9) {
        throw new HttpError(400, 'invalid-difficulty', 'Difficulty must be an integer from 0 to 9')
      }
      if (finished || round.state !== 'running') throw new HttpError(409, 'round-not-running', 'TTMC round is not running')
      const selected = this.ttmcTeam(command.side)
      const key = this.ttmcActionKey('start', roundId, selected.playerId)
      const stored = await this.state.storage.get<StoredTtmcStart>(key)
      if (stored) {
        if (stored.difficulty !== command.difficulty) throw new HttpError(409, 'difficulty-conflict', 'A different difficulty is already locked')
        const score = this.ttmcScore(selected.socket, roundId, selected.playerId)
        if (!score) throw new HttpError(409, 'ttmc-start-outcome-unknown', 'A previous question start is awaiting reconciliation')
        if (score.difficulty !== command.difficulty) {
          console.error('Stored TTMC difficulty conflicts with synchronized score')
          throw new HttpError(409, 'difficulty-conflict', 'The synchronized difficulty differs')
        }
        await this.loadTtmcQuestion(roundId, selected.playerId, selected.socket)
        return 'already-started'
      }
      const synchronized = this.ttmcScore(selected.socket, roundId, selected.playerId)
      if (synchronized) {
        if (synchronized.difficulty !== command.difficulty) throw new HttpError(409, 'difficulty-conflict', 'A different difficulty is already locked')
        await this.state.storage.put(key, { difficulty: command.difficulty } satisfies StoredTtmcStart)
        this.ttmcDifficulties.set(this.ttmcQuestionKey(roundId, selected.playerId), command.difficulty + 1)
        await this.loadTtmcQuestion(roundId, selected.playerId, selected.socket)
        await this.publishState()
        return 'already-started'
      }
      await this.state.storage.put(key, { difficulty: command.difficulty } satisfies StoredTtmcStart)
      this.ttmcDifficulties.set(this.ttmcQuestionKey(roundId, selected.playerId), command.difficulty + 1)
      try {
        await this.storeTtmcQuestion(roundId, selected.playerId, await selected.socket.request(roundId, 'start', command.difficulty))
        await selected.socket.waitForState((shared) => {
          const score = shared.list(roundId, 'scores').map(asObject)
            .find((candidate) => candidate !== null && Number(candidate.id) === selected.playerId)
          return score?.difficulty === command.difficulty ? true : undefined
        })
      } catch {
        // A lost response may already have created the score; get-question is the authoritative recovery path.
        const score = this.ttmcScore(selected.socket, roundId, selected.playerId)
        if (score?.difficulty === command.difficulty) {
          await this.loadTtmcQuestion(roundId, selected.playerId, selected.socket)
        } else {
          throw new HttpError(409, 'ttmc-start-outcome-unknown', 'The question start is awaiting reconciliation')
        }
      }
      await this.publishState()
      return 'accepted'
    }
    if (command.type === 'ttmc-answers') {
      if (finished || round.state !== 'running') throw new HttpError(409, 'round-not-running', 'TTMC round is not running')
      const values = asObject(command.answers)
      const sides = (['a', 'b'] as const).filter((side) => values && Object.hasOwn(values, side))
      if (!sides.length) throw new HttpError(400, 'invalid-answers', 'At least one answer is required')
      const prepared = await Promise.all(sides.map(async (side) => {
        const selected = this.ttmcTeam(side)
        const score = this.ttmcScore(selected.socket, roundId, selected.playerId)
        if (!score || !Number.isSafeInteger(score.difficulty) || Number(score.difficulty) < 0 || Number(score.difficulty) > 9) {
          throw new HttpError(409, 'ttmc-question-not-started', 'Choose a TTMC difficulty before answering')
        }
        const question = await this.loadTtmcQuestion(roundId, selected.playerId, selected.socket)
        const value = this.normalizeTtmcAnswer(question.raw, values![side])
        const key = this.ttmcActionKey('answer', roundId, selected.playerId)
        const questionKey = this.ttmcQuestionKey(roundId, selected.playerId)
        const stored = await this.state.storage.get<StoredTtmcAnswer>(key)
        if (stored) {
          if (JSON.stringify(stored.value) !== JSON.stringify(value)) throw new HttpError(409, 'answer-conflict', 'A different answer is already locked')
          const score = this.scoreForPlayer(roundId, selected.playerId)
          const played = Array.isArray(round.played) && round.played.some((id) => Number(id) === selected.playerId)
          if (stored.status === 'pending' && !(played && typeof score?.success === 'boolean')) {
            throw new HttpError(409, 'answer-outcome-unknown', 'A previous answer is awaiting reconciliation')
          }
          if (stored.status === 'pending') await this.state.storage.put(key, { status: 'accepted', value } satisfies StoredTtmcAnswer)
        }
        return { selected, value, key, questionKey, alreadySubmitted: stored !== undefined }
      }))
      const submissions = prepared.map(async ({ selected, value, key, questionKey, alreadySubmitted }) => {
        this.ttmcSubmitted.add(questionKey)
        if (alreadySubmitted) return 'already-submitted'
        await this.state.storage.put(key, { status: 'pending', value } satisfies StoredTtmcAnswer)
        let result: unknown
        try {
          result = await selected.socket.request(roundId, 'answer', value)
        } catch {
          throw new HttpError(409, 'answer-outcome-unknown', 'The answer is awaiting reconciliation')
        }
        const response = asObject(result)
        if (response?.success !== true) {
          console.warn('TTMC answer returned an ambiguous response')
          throw new HttpError(409, 'answer-outcome-unknown', 'The answer is awaiting reconciliation')
        }
        await this.state.storage.put(key, { status: 'accepted', value } satisfies StoredTtmcAnswer)
        return 'accepted'
      })
      const settled = await Promise.allSettled(submissions)
      await this.publishState()
      const rejected = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (rejected) throw rejected.reason
      return settled.map((result) => (result as PromiseFulfilledResult<string>).value)
    }
    if (!finished || this.ttmcRounds().some((candidate) => candidate.id !== roundId && candidate.state === 'running')) {
      throw new HttpError(409, 'round-not-finished', 'Finish the current TTMC round before continuing')
    }
    return this.startTtmcRound(host, this.ttmcActionKey('next', roundId))
  }

  private async handleCommand(command: JsonObject): Promise<unknown> {
    await this.ensureConnected()
    const { match, host, guest } = this
    if (!match || !host || !guest) throw new HttpError(409, 'match-not-ready', 'Match is not ready')
    if (typeof command.type !== 'string') throw new HttpError(400, 'invalid-action', 'Action is invalid')
    if (match.status !== 'finished' && !LIVE_STATUSES.has(match.status)) {
      throw new HttpError(409, 'match-not-live', 'Match is not live')
    }
    await this.requireSynchronizedPlayers(host)
    const party = asObject(host.shared.get(0, 'party'))

    if (party?.state === 'finished' || match.status === 'finished') {
      if (party?.state === 'finished') {
        await this.state.storage.put(FINISH_ACTION_KEY, { status: 'accepted' } satisfies StoredMutationAction)
      }
      await this.publishState()
      if (command.type === 'finish') return 'already-finished'
      throw new HttpError(409, 'match-not-live', 'Match is not live')
    }
    const initialTtmcStart = this.isTtmc() && command.type === 'start-ttmc-round' && this.ttmcRounds().length === 0
    if (!party || (party.state !== 'running' && !(initialTtmcStart && party.state === 'waiting'))) {
      throw new HttpError(409, 'party-not-running', 'Party is not running')
    }

    if (this.isTtmc()) return this.handleTtmcCommand(command, host)

    if (command.type === 'start-ttmc-round' || command.type === 'start-ttmc-question' || command.type === 'ttmc-answers' || command.type === 'next-ttmc-round') {
      throw new HttpError(400, 'unsupported-action', 'Action is not supported for Proximo')
    }

    if (command.type === 'finish') {
      if (await this.state.storage.get<StoredMutationAction>(FINISH_ACTION_KEY)) {
        throw new HttpError(409, 'finish-outcome-unknown', 'A previous finish action is awaiting reconciliation')
      }
      await this.state.storage.put(FINISH_ACTION_KEY, { status: 'pending' } satisfies StoredMutationAction)
      let result: unknown
      try {
        result = await host.request(0, 'finish-current-game', null)
      } catch {
        throw new HttpError(409, 'finish-outcome-unknown', 'The party finish is awaiting reconciliation')
      }
      if (result !== 'success' && result !== 'ok' && result !== 'no-running-game') {
        if (typeof result === 'string') {
          await this.state.storage.delete(FINISH_ACTION_KEY)
          throw new HttpError(502, 'finish-rejected', 'The game could not be finished')
        }
        console.warn('Proximo finish returned an ambiguous response')
        throw new HttpError(409, 'finish-outcome-unknown', 'The party finish is awaiting reconciliation')
      }
      try {
        await host.waitForState((shared) => {
          const synchronizedParty = asObject(shared.get(0, 'party'))
          return synchronizedParty?.state === 'finished' ? true : undefined
        })
      } catch {
        throw new HttpError(409, 'finish-outcome-unknown', 'The party finish is awaiting reconciliation')
      }
      await this.publishState()
      return result
    }

    if (command.type === 'start-proximo') {
      const existingGameId = await this.resolveGameId()
      if (existingGameId !== null) {
        await this.publishState()
        return 'success'
      }
      if (this.games().length) {
        console.warn('Refusing to treat an unidentified active game as Proximo')
        throw new HttpError(409, 'game-already-added', 'A game is already active')
      }
      return this.addProximo(host)
    }
    if (command.type === 'next-proximo') {
      if (typeof command.gameId !== 'number' || !Number.isSafeInteger(command.gameId)) {
        throw new HttpError(400, 'invalid-game-id', 'Game ID must be an integer')
      }
      const gameId = await this.resolveGameId()
      if (gameId == null) throw new HttpError(409, 'game-not-ready', 'Proximo has not been added')
      if (command.gameId !== gameId) throw new HttpError(409, 'game-id-mismatch', 'Action targets a stale game')
      const game = this.gameState(gameId)
      if (game.showAnswer !== true || game.state !== 'finished') {
        throw new HttpError(409, 'game-not-finished', 'Finish the current question before continuing')
      }
      return this.addProximo(host)
    }
    if (command.type === 'ready') {
      if (typeof command.gameId !== 'number' || !Number.isSafeInteger(command.gameId)) {
        throw new HttpError(400, 'invalid-game-id', 'Game ID must be an integer')
      }
      const gameId = await this.resolveGameId()
      if (gameId == null) throw new HttpError(409, 'game-not-ready', 'Proximo has not been added')
      if (command.gameId !== gameId) throw new HttpError(409, 'game-id-mismatch', 'Action targets a stale game')
      const [hostPlayerId, guestPlayerId] = this.expectedPlayerIds
      const hostScore = this.scoreForPlayer(gameId, hostPlayerId)
      const guestScore = this.scoreForPlayer(gameId, guestPlayerId)
      if (!hostScore || !guestScore) {
        console.warn('Ready command received before synchronized player scores were available')
        throw new HttpError(409, 'game-scores-not-synchronized', 'Game scores are not synchronized')
      }
      const settled = await Promise.allSettled([
        this.markReady(host, gameId, hostPlayerId, hostScore.isReady === true),
        this.markReady(guest, gameId, guestPlayerId, guestScore.isReady === true),
      ])
      const rejected = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (rejected) throw rejected.reason
      return settled.map((result) => (result as PromiseFulfilledResult<string>).value)
    }
    if (command.type === 'answers') {
      if (typeof command.gameId !== 'number' || !Number.isSafeInteger(command.gameId)) {
        throw new HttpError(400, 'invalid-game-id', 'Game ID must be an integer')
      }
      if (typeof command.currentRound !== 'number' || !Number.isSafeInteger(command.currentRound) || command.currentRound < 0) {
        throw new HttpError(400, 'invalid-current-round', 'Current round must be a nonnegative integer')
      }
      const answers = asObject(command.answers)
      const hasA = answers !== null && Object.hasOwn(answers, 'a')
      const hasB = answers !== null && Object.hasOwn(answers, 'b')
      const answerA = answers?.a
      const answerB = answers?.b
      if (!hasA && !hasB) throw new HttpError(400, 'invalid-answers', 'At least one answer is required')
      if (
        (hasA && (typeof answerA !== 'number' || !Number.isSafeInteger(answerA) || answerA < 0)) ||
        (hasB && (typeof answerB !== 'number' || !Number.isSafeInteger(answerB) || answerB < 0))
      ) {
        throw new HttpError(400, 'invalid-answers', 'Answers must be nonnegative whole numbers')
      }
      const gameId = await this.resolveGameId()
      if (gameId == null) throw new HttpError(409, 'game-not-ready', 'Proximo has not been added')
      if (command.gameId !== gameId) throw new HttpError(409, 'game-id-mismatch', 'Action targets a stale game')
      const game = this.gameState(gameId)
      const currentRound = game.currentRound
      if (typeof currentRound !== 'number' || !Number.isSafeInteger(currentRound) || currentRound < 0) {
        throw new HttpError(409, 'game-round-not-synchronized', 'Game round is not synchronized')
      }
      if (command.currentRound !== currentRound) {
        throw new HttpError(409, 'current-round-mismatch', 'Action targets a stale round')
      }
      if (typeof game.question !== 'string' || game.question.length === 0) {
        throw new HttpError(409, 'question-not-active', 'The question is not active')
      }
      if (game.showAnswer === true) throw new HttpError(409, 'question-revealed', 'The question is already revealed')
      await this.syncQuestionTiming()
      const identity = `${gameId}:${String(currentRound)}:${game.question}`
      if (!this.questionTiming || this.questionTiming.identity !== identity) {
        throw new HttpError(409, 'question-deadline-missing', 'The question deadline is not available')
      }
      if (this.questionTiming.deadlineAt <= Date.now()) {
        throw new HttpError(409, 'answer-deadline-expired', 'The answer deadline has expired')
      }
      const submissions: Promise<unknown>[] = []
      if (hasA) submissions.push(this.submitTeamAnswer('a', answerA as number, gameId, currentRound))
      if (hasB) submissions.push(this.submitTeamAnswer('b', answerB as number, gameId, currentRound))
      const settled = await Promise.allSettled(submissions)
      const rejected = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (rejected) throw rejected.reason
      return settled.map((result) => (result as PromiseFulfilledResult<unknown>).value)
    }
    throw new HttpError(400, 'unsupported-action', 'Action is not supported')
  }

  private broadcast(message: Record<string, unknown>): void {
    const encoded = JSON.stringify(message)
    for (const socket of this.state.getWebSockets()) {
      try { socket.send(encoded) } catch { socket.close(1011, 'Send failed') }
    }
  }

  async alarm(): Promise<void> {
    const matchId = await this.state.storage.get<string>('matchId')
    const terminal = await this.state.storage.get(TERMINAL_SNAPSHOT_KEY)
    if (!matchId || !isTerminalSnapshot(terminal, matchId)) {
      console.error('Terminal projection alarm has no valid terminal snapshot')
      return
    }
    this.terminalSnapshot = terminal
    if (!this.match) {
      const match = await this.env.DB.prepare('SELECT * FROM matches WHERE id = ?').bind(matchId).first<MatchRow>()
      if (!match) {
        console.error('Terminal projection alarm cannot find its match')
        return
      }
      this.match = match
    }
    await this.projectTerminal()
  }
}
