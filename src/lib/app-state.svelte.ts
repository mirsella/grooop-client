import {
  ApiError,
  cancelMatch,
  createChallenge,
  createMatch,
  createTeamPreset,
  deleteAccount,
  deleteTeamPreset,
  getAccounts,
  getMatches,
  getObservedQuestions,
  getTeamPresets,
  getTtmcCatalog,
  quoteMatch,
  reauthenticateAccount,
  refreshAccount,
  resumeMatch,
  updateTeamPreset,
  verifyChallenge,
  type Account,
  type Challenge,
  type Match,
  type MatchQuote,
  type MatchSetup,
  type ObservedQuestion,
  type TeamPreset,
  type TtmcAnswer,
  type TtmcCatalog,
} from '../api'
import {
  activeTtmcSide,
  cleanTeam,
  draftStorageKey,
  errorMessage,
  isActive,
  isCancellableMatch,
  isCompleteTtmcAnswer,
  isGameId,
  isResumableMatch,
  isRound,
  loadStoredDraft,
  lowestBalanceSide,
  sides,
  ttmcAnswerValue,
  type Draft,
  type MatchCommand,
  type Side,
  type Tab,
} from './domain'
import { LiveMatchConnection } from './live-match.svelte'

type TtmcCatalogResource =
  | { status: 'idle' }
  | { status: 'loading'; hostAccountId: string }
  | { status: 'ready'; hostAccountId: string; data: TtmcCatalog }
  | { status: 'error'; hostAccountId: string; message: string }
type Quote = MatchQuote & { idempotencyKey: string; setup: MatchSetup }

export class AppState {
  tab = $state<Tab>('play')
  draft = $state<Draft>(loadStoredDraft())
  quote = $state<Quote | null>(null)
  playBusy = $state<'quote' | 'create' | null>(null)
  playError = $state('')
  initialRestoreState = $state<'loading' | 'ready' | 'error'>('loading')
  initialRestoreError = $state('')
  accounts = $state<Account[] | null>(null)
  loadingAccounts = $state(true)
  accountError = $state('')
  email = $state('')
  code = $state('')
  challenge = $state<Challenge | null>(null)
  accountBusy = $state<string | null>(null)
  presets = $state<TeamPreset[] | null>(null)
  presetSelections = $state<Record<Side, string>>({ a: '', b: '' })
  presetBusy = $state<string | null>(null)
  presetError = $state('')
  ttmcCatalog = $state<TtmcCatalogResource>({ status: 'idle' })
  ttmcCatalogRefresh = $state(0)
  matches = $state<Match[]>([])
  questions = $state<ObservedQuestion[] | null>(null)
  historyLoading = $state(false)
  historyError = $state('')
  currentMatchId = $state<string | null>(null)
  resumingMatchId = $state<string | null>(null)
  cancellingMatchId = $state<string | null>(null)
  answers = $state<Record<Side, string>>({ a: '', b: '' })
  ttmcAnswers = $state<Partial<Record<Side, TtmcAnswer>>>({})
  ttmcDifficulties = $state<Record<Side, number>>({ a: 1, b: 1 })
  liveAnnouncement = $state('')
  autoReadyKey = $state<string | null>(null)
  quoteRefresh = $state(0)

  readonly live: LiveMatchConnection
  private quoteVersion = 0
  private quoteController: AbortController | null = null
  private quoteTimer: number | undefined
  private catalogController: AbortController | null = null
  private accountLoadVersion = 0
  private presetLoadVersion = 0
  private matchLoadVersion = 0
  private questionLoadVersion = 0
  private historyLoadVersion = 0
  private terminalMatchStates = new Map<string, string>()
  private initialRestoreAllowed = true
  private autoReadySentKey: string | null = null
  private announcedQuestion = ''
  private announcedReveal = ''
  private announcedTtmcTopic = ''
  private announcedTtmcQuestions: Record<Side, string> = { a: '', b: '' }
  private announcedTtmcResult = ''
  private answerGameKey = ''
  private destroyed = false
  private lifecycleController = new AbortController()

  constructor() {
    this.live = new LiveMatchConnection(
      (command) => this.actionRejected(command),
      (match) => this.authoritativeState(match),
    )
  }

  get activeAccounts() { return this.accounts?.filter(isActive) ?? [] }
  get selectedAccounts() {
    return {
      a: this.accounts?.find((account) => account.id === this.draft.accountIds.a),
      b: this.accounts?.find((account) => account.id === this.draft.accountIds.b),
    }
  }
  get cleanedTeams() { return { a: cleanTeam(this.draft.teams.a), b: cleanTeam(this.draft.teams.b) } }
  get ttmcHostAccountId() { return this.draft.accountIds[this.draft.host] }
  get readyTtmcCatalog() {
    return this.ttmcCatalog.status === 'ready' && this.ttmcCatalog.hostAccountId === this.ttmcHostAccountId
      ? this.ttmcCatalog.data : null
  }
  get ttmcContentSlugs() { return this.draft.ttmcSelections[this.ttmcHostAccountId]?.slugs ?? [] }
  get ttmcContents() { return this.readyTtmcCatalog?.contents ?? [] }
  get ttmcRounds() { return this.readyTtmcCatalog?.rounds }
  get ttmcRoundsValid() {
    const rounds = this.ttmcRounds
    return rounds !== undefined && this.draft.rounds >= rounds.min && this.draft.rounds <= rounds.max &&
      (this.draft.rounds - rounds.min) % rounds.step === 0
  }
  get ttmcSelectionValid() {
    return this.ttmcContentSlugs.length > 0 && this.ttmcContentSlugs.every((slug) => this.ttmcContents.some((item) => item.slug === slug))
  }
  get allTtmcContentsSelected() {
    return this.ttmcContents.length > 0 && this.ttmcContentSlugs.length === this.ttmcContents.length &&
      this.ttmcContents.every((item) => this.ttmcContentSlugs.includes(item.slug))
  }
  get setup(): MatchSetup {
    const shared = {
      hostAccountId: this.ttmcHostAccountId,
      teamAAccountId: this.draft.accountIds.a,
      teamBAccountId: this.draft.accountIds.b,
      teamA: this.cleanedTeams.a,
      teamB: this.cleanedTeams.b,
    }
    return this.draft.gameMode === 'proximo'
      ? { ...shared, gameMode: 'proximo', contentSlug: this.draft.contentSlug, durationMinutes: this.draft.durationMinutes }
      : { ...shared, gameMode: 'ttmc', rounds: this.draft.rounds, ttmcContentSlugs: this.ttmcContentSlugs }
  }
  get setupSignature() { return JSON.stringify(this.setup) }
  get setupValid() {
    const accountsReady = this.accounts !== null && !this.loadingAccounts
    return accountsReady && this.activeAccounts.length >= 2 && this.draft.accountIds.a !== this.draft.accountIds.b &&
      sides.every((side) => this.activeAccounts.some((account) => account.id === this.draft.accountIds[side])) &&
      sides.every((side) => this.cleanedTeams[side].name && this.cleanedTeams[side].roster.length) &&
      (this.draft.gameMode === 'proximo' || (this.readyTtmcCatalog?.owned === true && this.ttmcContents.length > 0 && this.ttmcSelectionValid && this.ttmcRoundsValid))
  }
  get setupLocked() { return this.accounts === null || this.loadingAccounts || this.playBusy === 'create' }
  get ttmcCatalogLoading() { return this.ttmcCatalog.status === 'loading' && this.ttmcCatalog.hostAccountId === this.ttmcHostAccountId }
  get ttmcCatalogError() { return this.ttmcCatalog.status === 'error' && this.ttmcCatalog.hostAccountId === this.ttmcHostAccountId ? this.ttmcCatalog.message : '' }
  get ttmcSetupBlocker() {
    if (this.draft.gameMode !== 'ttmc') return ''
    if (this.ttmcCatalogLoading) return 'TTMC packs are still loading.'
    if (this.ttmcCatalogError) return 'TTMC packs could not be loaded. Retry loading TTMC packs.'
    if (!this.readyTtmcCatalog) return 'Choose a TTMC host to load its packs.'
    if (!this.readyTtmcCatalog.owned) return 'The selected host does not own TTMC.'
    if (!this.ttmcContents.length) return 'No TTMC packs are available for the selected host.'
    if (!this.ttmcSelectionValid) return 'Select at least one TTMC pack to price this match.'
    if (!this.ttmcRoundsValid) return 'The TTMC topic count is unavailable.'
    return ''
  }
  get currentMatch() { return this.matches.find((match) => match.id === this.currentMatchId) }
  get activeMatches() { return this.matches.filter(isResumableMatch) }
  get pastMatches() { return this.matches.filter((match) => !isResumableMatch(match)) }
  get proximoGame() { return this.live.match?.gameMode === 'proximo' ? this.live.match.game : null }
  get ttmcGame() { return this.live.match?.gameMode === 'ttmc' ? this.live.match.game : null }
  get activeTtmcTeam() { return this.ttmcGame ? activeTtmcSide(this.ttmcGame) : null }
  get matchLive() { return this.live.match !== null && !['finished', 'failed', 'cancelled'].includes(this.live.match.status.toLowerCase()) }
  get gameplayEnabled() { return this.live.state === 'open' && this.live.match?.connected === true }
  get gameplayDraftDisabled() { return !this.gameplayEnabled || this.live.inFlight !== null }
  get gameReady() { return (this.proximoGame?.scores.length ?? 0) >= 2 && this.proximoGame?.scores.every((score) => score.isReady) === true }

  async init() {
    void this.loadAccounts()
    void this.loadPresets()
    if (document.readyState !== 'complete') {
      const signal = this.lifecycleController.signal
      await Promise.race([
        new Promise<void>((resolve) => window.addEventListener('load', () => resolve(), { once: true, signal })),
        new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
      ])
    }
    if (this.destroyed) return
    await this.restoreInitialMatch()
  }

  destroy() {
    this.destroyed = true
    this.lifecycleController.abort()
    this.accountLoadVersion += 1
    this.presetLoadVersion += 1
    this.matchLoadVersion += 1
    this.questionLoadVersion += 1
    this.historyLoadVersion += 1
    this.live.close()
    this.quoteController?.abort()
    this.catalogController?.abort()
    if (this.quoteTimer !== undefined) window.clearTimeout(this.quoteTimer)
  }

  navigate(tab: Tab) {
    this.initialRestoreAllowed = false
    this.tab = tab
    if (tab === 'history') void this.loadHistory()
  }

  editDraft(change: (draft: Draft) => Draft) {
    this.invalidateQuote()
    this.playError = ''
    this.draft = change(this.draft)
    try { localStorage.setItem(draftStorageKey, JSON.stringify(this.draft)) }
    catch (error) { console.warn('Could not save the match setup.', error) }
  }

  editRoster(side: Side, operation: 'add' | 'remove' | 'set', index = 0, value = '') {
    this.editDraft((draft) => {
      const roster = draft.teams[side].roster
      let next = roster
      if (operation === 'set') next = roster.map((player, itemIndex) => itemIndex === index ? value : player)
      if (operation === 'add' && roster.length < 12) next = [...roster, '']
      if (operation === 'remove' && roster.length > 1) next = roster.filter((_, itemIndex) => itemIndex !== index)
      return { ...draft, teams: { ...draft.teams, [side]: { ...draft.teams[side], roster: next } } }
    })
  }

  private invalidateQuote() {
    this.quoteController?.abort()
    this.quoteController = null
    this.quoteVersion += 1
    this.quote = null
    if (this.playBusy === 'quote') this.playBusy = null
  }

  refreshQuote = () => {
    this.invalidateQuote()
    this.quoteRefresh += 1
    this.scheduleQuote()
  }

  scheduleQuote() {
    if (this.quoteTimer !== undefined) window.clearTimeout(this.quoteTimer)
    if (!this.setupValid || this.initialRestoreState !== 'ready') return
    this.quoteTimer = window.setTimeout(() => void this.requestQuote(), 300)
  }

  async requestQuote() {
    if (!this.setupValid || this.initialRestoreState !== 'ready') {
      if (this.initialRestoreState !== 'ready') this.playError = 'Check for an active match before requesting a quote.'
      return
    }
    const setup = structuredClone($state.snapshot(this.setup)) as MatchSetup
    const version = ++this.quoteVersion
    this.quoteController?.abort()
    const controller = new AbortController()
    this.quoteController = controller
    this.quote = null
    this.playBusy = 'quote'
    this.playError = ''
    try {
      const { quote } = await quoteMatch(setup, controller.signal)
      if (this.quoteVersion === version) this.quote = { ...quote, setup, idempotencyKey: crypto.randomUUID() }
    } catch (error) {
      if (!controller.signal.aborted && this.quoteVersion === version) this.playError = errorMessage(error, 'Could not quote this match.')
    } finally {
      if (this.quoteVersion === version) {
        this.quoteController = null
        this.playBusy = null
      }
    }
  }

  async submitMatch() {
    if (!this.quote?.userCanSpend || this.initialRestoreState !== 'ready') return
    this.playBusy = 'create'
    this.playError = ''
    try {
      const { match } = await createMatch(this.quote.setup, this.quote.cost, this.quote.idempotencyKey)
      if (!isCancellableMatch(match)) throw new Error(`The match returned an invalid status: ${match.status}.`)
      this.invalidateQuote()
      this.matchLoadVersion += 1
      this.matches = [match, ...this.matches.filter((item) => item.id !== match.id)]
      this.currentMatchId = match.id
      this.navigate('match')
      this.live.open(match.id)
    } catch (error) {
      if (error instanceof ApiError && error.code === 'party-cost-changed') this.refreshQuote()
      this.playError = errorMessage(error, 'Could not create this match.')
    } finally { this.playBusy = null }
  }

  private reconcileAccountAssignments(loaded: Account[]) {
    const active = loaded.filter(isActive)
    this.editDraft((draft) => {
      const valid = (id: string) => active.some((account) => account.id === id)
      let a = valid(draft.accountIds.a) ? draft.accountIds.a : ''
      let b = valid(draft.accountIds.b) ? draft.accountIds.b : ''
      if (a === b) b = ''
      if (!a) a = active.find((account) => account.id !== b)?.id ?? ''
      if (!b) b = active.find((account) => account.id !== a)?.id ?? ''
      const accountIds = { a, b }
      const unchanged = a === draft.accountIds.a && b === draft.accountIds.b
      return { ...draft, accountIds, host: unchanged ? draft.host : lowestBalanceSide(accountIds, active, draft.host) }
    })
  }

  async loadAccounts() {
    const version = ++this.accountLoadVersion
    this.loadingAccounts = true
    this.accountError = ''
    try {
      const { accounts } = await getAccounts()
      if (this.accountLoadVersion !== version) return
      this.accounts = accounts
      this.reconcileAccountAssignments(accounts)
    } catch (error) {
      if (this.accountLoadVersion === version) this.accountError = errorMessage(error, 'Could not load the account list.')
    } finally { if (this.accountLoadVersion === version) this.loadingAccounts = false }
  }

  async loadPresets() {
    const version = ++this.presetLoadVersion
    this.presetError = ''
    try {
      const { presets } = await getTeamPresets()
      if (this.presetLoadVersion === version) this.presets = presets
    } catch (error) { if (this.presetLoadVersion === version) this.presetError = errorMessage(error, 'Could not load team presets.') }
  }

  async loadTtmcCatalog() {
    this.catalogController?.abort()
    const host = this.ttmcHostAccountId
    if (this.draft.gameMode !== 'ttmc' || !host) { this.ttmcCatalog = { status: 'idle' }; return }
    const controller = new AbortController()
    this.catalogController = controller
    this.ttmcCatalog = { status: 'loading', hostAccountId: host }
    try {
      const catalog = await getTtmcCatalog(host, controller.signal)
      if (controller.signal.aborted || this.ttmcHostAccountId !== host || this.draft.gameMode !== 'ttmc') return
      this.ttmcCatalog = { status: 'ready', hostAccountId: host, data: catalog }
      const available = catalog.contents.map((item) => item.slug)
      const previous = this.draft.ttmcSelections[host]
      const selected = previous?.all ? available : previous ? previous.slugs.filter((slug) => available.includes(slug)) : available
      const selection = { slugs: selected, all: previous?.all ?? true }
      const rounds = catalog.rounds
      const validRounds = this.draft.rounds >= rounds.min && this.draft.rounds <= rounds.max && (this.draft.rounds - rounds.min) % rounds.step === 0
      if (previous?.all === selection.all && selected.length === previous.slugs.length && selected.every((slug, index) => slug === previous.slugs[index]) && validRounds) return
      this.editDraft((draft) => draft.gameMode === 'ttmc' && draft.accountIds[draft.host] === host ? {
        ...draft,
        rounds: validRounds ? draft.rounds : rounds.default,
        ttmcSelections: { ...draft.ttmcSelections, [host]: selection },
      } : draft)
    } catch (error) {
      if (!controller.signal.aborted) this.ttmcCatalog = { status: 'error', hostAccountId: host, message: errorMessage(error, 'Could not load TTMC packs.') }
    }
  }

  retryTtmcCatalog() { this.ttmcCatalogRefresh += 1 }
  toggleTtmcContent(slug: string) {
    this.editDraft((draft) => {
      const current = draft.ttmcSelections[this.ttmcHostAccountId]?.slugs ?? []
      const changed = current.includes(slug) ? current.filter((item) => item !== slug) : [...current, slug]
      const ordered = this.ttmcContents.map((item) => item.slug).filter((item) => changed.includes(item))
      return { ...draft, ttmcSelections: { ...draft.ttmcSelections, [this.ttmcHostAccountId]: { slugs: ordered, all: ordered.length === this.ttmcContents.length } } }
    })
  }
  selectAllTtmcContents() {
    const slugs = this.ttmcContents.map((item) => item.slug)
    this.editDraft((draft) => ({ ...draft, ttmcSelections: { ...draft.ttmcSelections, [this.ttmcHostAccountId]: { slugs, all: true } } }))
  }

  private reconcileTerminal(loaded: Match[]) {
    return loaded.map((match) => this.terminalMatchStates.has(match.id) ? { ...match, status: this.terminalMatchStates.get(match.id)! } : match)
  }
  async restoreInitialMatch() {
    const version = ++this.matchLoadVersion
    this.initialRestoreState = 'loading'
    this.initialRestoreError = ''
    try {
      const result = await getMatches()
      if (this.matchLoadVersion !== version) return
      const reconciled = this.reconcileTerminal(result.matches)
      this.matches = reconciled
      let active = reconciled.find(isResumableMatch)
      if (active?.status.toLowerCase() === 'joining') {
        active = (await resumeMatch(active.id)).match
        if (this.matchLoadVersion !== version) return
        this.matches = [active, ...this.matches.filter((item) => item.id !== active!.id)]
      }
      this.initialRestoreState = 'ready'
      if (active && this.initialRestoreAllowed) {
        this.currentMatchId = active.id
        this.tab = 'match'
        this.live.open(active.id)
      } else this.scheduleQuote()
    } catch (error) {
      if (this.matchLoadVersion !== version) return
      this.initialRestoreError = errorMessage(error, 'Could not restore the active match.')
      this.initialRestoreState = 'error'
    }
  }

  async loadHistory() {
    const loadingVersion = ++this.historyLoadVersion
    const matchesVersion = ++this.matchLoadVersion
    const questionsVersion = ++this.questionLoadVersion
    this.historyLoading = true
    this.historyError = ''
    const [matches, questions] = await Promise.allSettled([getMatches(), getObservedQuestions()])
    if (this.historyLoadVersion !== loadingVersion) return
    const errors: string[] = []
    if (matches.status === 'fulfilled' && this.matchLoadVersion === matchesVersion) this.matches = this.reconcileTerminal(matches.value.matches)
    else if (matches.status === 'rejected') errors.push(errorMessage(matches.reason, 'Could not load match history.'))
    if (questions.status === 'fulfilled' && this.questionLoadVersion === questionsVersion) this.questions = questions.value.questions
    else if (questions.status === 'rejected') errors.push(errorMessage(questions.reason, 'Could not load question history.'))
    this.historyError = errors.join(' ')
    this.historyLoading = false
  }

  async requestCode(event: SubmitEvent) {
    event.preventDefault(); this.accountError = ''; this.accountBusy = 'challenge'
    try { const { challenge } = await createChallenge(this.email.trim()); this.challenge = challenge; this.code = '' }
    catch (error) { this.accountError = errorMessage(error, 'Could not send a code.') }
    finally { this.accountBusy = null }
  }
  async confirmCode(event: SubmitEvent) {
    event.preventDefault(); if (!this.challenge) return
    this.accountError = ''; this.accountBusy = 'verify'
    try {
      await verifyChallenge(this.challenge.id, this.code.trim())
      this.challenge = null; this.email = ''; this.code = ''
      await this.loadAccounts(); this.ttmcCatalogRefresh += 1
    } catch (error) { this.accountError = errorMessage(error, 'That code could not be confirmed.') }
    finally { this.accountBusy = null }
  }
  async updateAccount(id: string, operation: 'refresh' | 'remove') {
    if (operation === 'remove' && !confirm('Remove this account from Grooop Client?')) return
    this.accountError = ''; this.accountBusy = `${operation}-${id}`
    try {
      if (operation === 'refresh') {
        this.accountLoadVersion += 1
        const { account } = await refreshAccount(id)
        if (this.accounts === null) { console.warn('Received an account refresh while the account list is unavailable.'); return }
        this.accounts = this.accounts.map((item) => item.id === id ? account : item)
        this.reconcileAccountAssignments(this.accounts)
        if (id === this.ttmcHostAccountId) this.ttmcCatalogRefresh += 1
      } else { await deleteAccount(id); await this.loadAccounts() }
    } catch (error) {
      if (operation === 'refresh' && error instanceof ApiError && (error.status === 401 || error.code.includes('unauthorized'))) await this.loadAccounts()
      this.accountError = errorMessage(error, `Could not ${operation} this account.`)
    } finally { this.accountBusy = null }
  }
  async startReauthentication(id: string) {
    this.accountError = ''; this.accountBusy = `reauthenticate-${id}`
    try { const { challenge } = await reauthenticateAccount(id); this.challenge = challenge; this.code = ''; this.email = '' }
    catch (error) { this.accountError = errorMessage(error, 'Could not send a re-authentication code.') }
    finally { this.accountBusy = null }
  }

  applyPreset(side: Side) {
    const preset = this.presets?.find((item) => item.id === this.presetSelections[side])
    if (preset) this.editDraft((draft) => ({ ...draft, teams: { ...draft.teams, [side]: { name: preset.name, roster: [...preset.roster] } } }))
  }
  async savePreset(side: Side) {
    const input = cleanTeam(this.draft.teams[side]); if (!input.name || !input.roster.length) return
    const id = this.presetSelections[side]; this.presetError = ''; this.presetBusy = `save-${side}`; this.presetLoadVersion += 1
    try {
      const { preset } = id ? await updateTeamPreset(id, input) : await createTeamPreset(input)
      this.presets = [preset, ...(this.presets ?? []).filter((item) => item.id !== preset.id)]
      this.presetSelections = { ...this.presetSelections, [side]: preset.id }
    } catch (error) { this.presetError = errorMessage(error, 'Could not save this team preset.') }
    finally { this.presetBusy = null }
  }
  async removePreset(side: Side) {
    const id = this.presetSelections[side]; if (!id || !confirm('Delete this team preset?')) return
    this.presetError = ''; this.presetBusy = `delete-${side}`; this.presetLoadVersion += 1
    try {
      await deleteTeamPreset(id)
      this.presets = this.presets?.filter((item) => item.id !== id) ?? null
      this.presetSelections = { a: this.presetSelections.a === id ? '' : this.presetSelections.a, b: this.presetSelections.b === id ? '' : this.presetSelections.b }
    } catch (error) { this.presetError = errorMessage(error, 'Could not delete this team preset.') }
    finally { this.presetBusy = null }
  }

  openMatch(id: string) { this.initialRestoreAllowed = false; this.currentMatchId = id; this.navigate('match'); this.live.open(id) }
  async resumeAndOpen(match: Match) {
    this.historyError = ''; this.resumingMatchId = match.id
    try {
      const resumed = match.status.toLowerCase() === 'joining' ? (await resumeMatch(match.id)).match : match
      this.matches = [resumed, ...this.matches.filter((item) => item.id !== resumed.id)]
      this.openMatch(resumed.id)
    } catch (error) { this.historyError = errorMessage(error, 'Could not resume this match.') }
    finally { this.resumingMatchId = null }
  }
  async cancelActiveMatch(match: Match) {
    if (!confirm(`Cancel ${match.teamA.name} vs ${match.teamB.name} for both teams?`)) return
    this.historyError = ''; this.cancellingMatchId = match.id
    try {
      const { match: cancelled } = await cancelMatch(match.id)
      this.terminalMatchStates.set(cancelled.id, cancelled.status); this.matchLoadVersion += 1
      this.matches = this.matches.map((item) => item.id === cancelled.id ? cancelled : item)
      if (this.currentMatchId === cancelled.id) { this.currentMatchId = null; this.live.open(null) }
      this.refreshQuote()
    } catch (error) { this.historyError = errorMessage(error, 'Could not cancel this match.') }
    finally { this.cancellingMatchId = null }
  }

  submitAnswers() {
    const game = this.proximoGame
    if (!game || !isGameId(game.id) || !isRound(game.currentRound)) return this.live.fail('The current game identity is unavailable; answers were not sent.')
    if (game.questionDeadlineAt === null) return this.live.fail('The question deadline is unavailable; answers were not sent.')
    if (Date.now() >= game.questionDeadlineAt) return this.live.fail('Answering is closed for this question.')
    const submitted = this.proximoSubmitted
    const unresolved = sides.filter((side) => !submitted[side])
    const parsed = { a: Number(this.answers.a), b: Number(this.answers.b) }
    const complete = unresolved.filter((side) => this.answers[side] !== '' && Number.isSafeInteger(parsed[side]) && parsed[side] >= 0)
    if (!complete.length) {
      const invalid = unresolved.find((side) => this.answers[side] !== '')
      return this.live.fail(invalid ? `Team ${invalid.toUpperCase()} answer must be a nonnegative whole number.` : 'Complete at least one team answer before locking.')
    }
    const batch: Partial<Record<Side, number>> = {}
    complete.forEach((side) => { batch[side] = parsed[side] })
    if (this.live.send({ type: 'answers', gameId: game.id, currentRound: game.currentRound, answers: batch })) {
      this.answers = { ...this.answers, ...Object.fromEntries(complete.map((side) => [side, ''])) }
    }
  }
  get userIdBySide() {
    return {
      a: this.accounts?.find((account) => account.id === this.live.match?.teams.a.accountId)?.userId,
      b: this.accounts?.find((account) => account.id === this.live.match?.teams.b.accountId)?.userId,
    }
  }
  scoreForSide(side: Side) { return this.proximoGame?.scores.find((score) => score.id === this.userIdBySide[side]) }
  get proximoSubmitted() { return { a: this.scoreForSide('a')?.submitted === true, b: this.scoreForSide('b')?.submitted === true } }
  sideForUserId(id: number | null) { return id === null ? undefined : sides.find((side) => this.userIdBySide[side] === id) }
  startTtmcQuestion(side: Side) {
    const game = this.ttmcGame
    if (!game || game.teams[side].difficulty !== null) return this.live.fail('This team cannot start a TTMC question yet.')
    this.live.send({ type: 'start-ttmc-question', roundId: game.id, side, difficulty: this.ttmcDifficulties[side] - 1 })
  }
  submitTtmcAnswers() {
    const game = this.ttmcGame
    if (!game) return this.live.fail('The current TTMC round identity is unavailable; answers were not sent.')
    const side = activeTtmcSide(game); if (!side || !game.teams[side].question) return this.live.fail("The active team's question is not ready.")
    const question = game.teams[side].question
    const value = ttmcAnswerValue(question, this.ttmcAnswers[side])
    if (!isCompleteTtmcAnswer(question, value)) return this.live.fail(`Complete Team ${side.toUpperCase()}'s answer before locking.`)
    const answer = question.type === 'oneword' ? (value as string).trim().toLowerCase() : value!
    this.live.send({ type: 'ttmc-answers', roundId: game.id, answers: { [side]: answer } })
  }
  finishMatch() { if (confirm('End this match for both teams?')) this.live.send({ type: 'finish' }) }

  syncLiveEffects() {
    const proximo = this.proximoGame
    const ttmc = this.ttmcGame
    const gameKey = `${proximo?.id}:${proximo?.currentRound}:${ttmc?.id}:${ttmc?.roundNumber}`
    if (gameKey !== this.answerGameKey) { this.answerGameKey = gameKey; this.answers = { a: '', b: '' }; this.ttmcAnswers = {} }
    if (ttmc) {
      const confirmed = sides.filter((side) => ttmc.teams[side].submitted && this.ttmcAnswers[side] !== undefined)
      if (confirmed.length) {
        const next = { ...this.ttmcAnswers }; confirmed.forEach((side) => { delete next[side] }); this.ttmcAnswers = next
      }
    }
    const readyKey = this.currentMatchId && proximo && isGameId(proximo.id) ? `${this.currentMatchId}:${proximo.id}` : null
    if (readyKey && proximo?.currentRound === -1 && !this.gameReady && !proximo.showAnswer && this.gameplayEnabled && !this.live.inFlight && this.autoReadySentKey !== readyKey) {
      this.autoReadySentKey = readyKey; this.autoReadyKey = readyKey; this.live.send({ type: 'ready', gameId: proximo.id })
    }
    if (proximo && isGameId(proximo.id) && isRound(proximo.currentRound)) {
      const key = `${proximo.id}:${proximo.currentRound}`
      if (proximo.question && !proximo.showAnswer && this.announcedQuestion !== key) { this.announcedQuestion = key; this.liveAnnouncement = `New question: ${proximo.question}` }
      else if (proximo.showAnswer && this.announcedReveal !== key) { this.announcedReveal = key; this.liveAnnouncement = `Answer revealed: ${proximo.answer ?? 'not supplied'}` }
    }
    if (ttmc) {
      const announcements: string[] = []
      const topicKey = `${ttmc.id}:${ttmc.roundNumber}:${ttmc.category}:${ttmc.title}`
      if (this.announcedTtmcTopic !== topicKey) { this.announcedTtmcTopic = topicKey; announcements.push(`TTMC topic ${ttmc.roundNumber} of ${ttmc.totalRounds}: ${ttmc.title ?? ttmc.category ?? 'topic pending'}`) }
      for (const side of sides) {
        const question = ttmc.teams[side].question; if (!question) continue
        const key = `${ttmc.id}:${ttmc.roundNumber}:${question.prompt}`
        if (this.announcedTtmcQuestions[side] !== key) { this.announcedTtmcQuestions[side] = key; announcements.push(`Team ${side.toUpperCase()} question: ${question.prompt}`) }
      }
      const resultKey = `${ttmc.id}:${ttmc.roundNumber}:result`
      if (ttmc.state === 'finished' && sides.every((side) => ttmc.teams[side].success !== null) && this.announcedTtmcResult !== resultKey) {
        this.announcedTtmcResult = resultKey
        announcements.push(`TTMC topic result: ${sides.map((side) => `Team ${side.toUpperCase()} ${ttmc.teams[side].success ? 'correct' : 'incorrect'}, ${ttmc.teams[side].points ?? 0} points`).join('. ')}`)
      }
      if (announcements.length) this.liveAnnouncement = announcements.join('. ')
    }
  }

  private actionRejected(command: MatchCommand) {
    if (command.type === 'answers') {
      this.answers = { ...this.answers, ...Object.fromEntries(Object.entries(command.answers).map(([side, value]) => [side, String(value)])) }
    }
  }
  private authoritativeState(match: import('../api').LiveMatch) {
    if (!['finished', 'failed', 'cancelled'].includes(match.status.toLowerCase()) || this.terminalMatchStates.has(match.id)) return
    this.terminalMatchStates.set(match.id, match.status); this.matchLoadVersion += 1
    this.matches = this.matches.map((item) => item.id === match.id ? { ...item, status: match.status } : item)
    this.refreshQuote()
  }
}
