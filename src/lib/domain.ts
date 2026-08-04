import type {
  Account,
  LiveGame,
  LiveMatch,
  LivePlayer,
  LiveScore,
  Match,
  MatchStatus,
  MatchTeam,
  TtmcAnswer,
  TtmcGame,
  TtmcQuestion,
} from '../api'

export type Tab = 'play' | 'match' | 'history' | 'settings'
export type Side = 'a' | 'b'
export type ContentSlug = 'all' | '300' | '299' | 'geographie' | 'sciences'
export type TtmcSelection = { slugs: string[]; all: boolean }
export type Draft = {
  host: Side
  accountIds: Record<Side, string>
  teams: Record<Side, { name: string; roster: string[] }>
  contentSlug: ContentSlug
  durationMinutes: number
  gameMode: 'proximo' | 'ttmc'
  rounds: number
  ttmcSelections: Record<string, TtmcSelection>
}
export type MatchCommand =
  | { type: 'start-proximo' }
  | { type: 'next-proximo'; gameId: number }
  | { type: 'ready'; gameId: number }
  | { type: 'answers'; gameId: number; currentRound: number; answers: Partial<Record<Side, number>> }
  | { type: 'start-ttmc-round' }
  | { type: 'start-ttmc-question'; roundId: number; side: Side; difficulty: number }
  | { type: 'ttmc-answers'; roundId: number; answers: Partial<Record<Side, TtmcAnswer>> }
  | { type: 'next-ttmc-round'; roundId: number }
  | { type: 'finish' }

export const sides: Side[] = ['a', 'b']
export const draftStorageKey = 'grooop-client.match-draft'
export const content: ReadonlyArray<readonly [ContentSlug, string, string]> = [
  ['all', 'All', 'All four categories, shuffled together'],
  ['300', '300', 'Movie lines & cultural classics'],
  ['299', '299', 'The oddball little sister'],
  ['geographie', 'Geography', 'Maps, cities & landmarks'],
  ['sciences', 'Sciences', 'Experiments, nature & why'],
]
export const initialDraft: Draft = {
  host: 'a',
  accountIds: { a: '', b: '' },
  teams: {
    a: { name: 'Team A', roster: ['Player one', 'Player two'] },
    b: { name: 'Team B', roster: ['Player three', 'Player four'] },
  },
  contentSlug: 'all',
  durationMinutes: 30,
  gameMode: 'proximo',
  rounds: 5,
  ttmcSelections: {},
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isStoredDraft(value: unknown): value is Draft {
  if (!isRecord(value)) return false
  const { accountIds, teams, ttmcSelections } = value
  const validTeam = (team: unknown) => isRecord(team) && typeof team.name === 'string' && team.name.length <= 40 &&
    Array.isArray(team.roster) && team.roster.length >= 1 && team.roster.length <= 12 &&
    team.roster.every((player) => typeof player === 'string' && player.length <= 40)
  const validSelection = ([accountId, selection]: [string, unknown]) => accountId.length > 0 && accountId.length <= 128 &&
    isRecord(selection) && typeof selection.all === 'boolean' && Array.isArray(selection.slugs) &&
    selection.slugs.length <= 32 && selection.slugs.every((slug) => typeof slug === 'string' && slug.length <= 80) &&
    new Set(selection.slugs).size === selection.slugs.length
  return (value.host === 'a' || value.host === 'b') && isRecord(accountIds) &&
    typeof accountIds.a === 'string' && accountIds.a.length <= 128 &&
    typeof accountIds.b === 'string' && accountIds.b.length <= 128 && isRecord(teams) &&
    validTeam(teams.a) && validTeam(teams.b) && content.some(([slug]) => slug === value.contentSlug) &&
    [15, 30, 45].includes(value.durationMinutes as number) &&
    (value.gameMode === 'proximo' || value.gameMode === 'ttmc') && Number.isInteger(value.rounds) &&
    (value.rounds as number) >= 2 && (value.rounds as number) <= 10 && isRecord(ttmcSelections) &&
    Object.entries(ttmcSelections).every(validSelection)
}

export function loadStoredDraft(): Draft {
  try {
    const stored = localStorage.getItem(draftStorageKey)
    if (stored === null) return structuredClone(initialDraft)
    const payload: unknown = JSON.parse(stored)
    if (isStoredDraft(payload)) return payload
    console.warn('Ignoring invalid saved match setup.')
  } catch (error) {
    console.warn('Could not load the saved match setup.', error)
  }
  return structuredClone(initialDraft)
}

export const cleanTeam = (team: Draft['teams'][Side]) => ({
  name: team.name.trim(),
  roster: team.roster.map((player) => player.trim()).filter(Boolean),
})
export const isActive = (account: Account) => account.status.toLowerCase() === 'active'
export const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback
const resumableStatuses: MatchStatus[] = ['joining', 'waiting', 'playing', 'revealed']
const liveStatuses: MatchStatus[] = ['waiting', 'playing', 'revealed']
const terminalStatuses: MatchStatus[] = ['finished', 'cancelled']
export const isResumableStatus = (status: MatchStatus) => resumableStatuses.includes(status)
export const isLiveStatus = (status: MatchStatus) => liveStatuses.includes(status)
export const isTerminalStatus = (status: MatchStatus) => terminalStatuses.includes(status)
export const isResumableMatch = (match: Match) => !match.finishedAt && isResumableStatus(match.status)
export const isCancellableMatch = (match: Match) => isResumableMatch(match) && match.status !== 'joining'
export function lowestBalanceSide(accountIds: Record<Side, string>, accounts: Account[], fallback: Side): Side {
  const a = accounts.find((account) => account.id === accountIds.a)
  const b = accounts.find((account) => account.id === accountIds.b)
  if (!a || !b || a.grooopies === b.grooopies) return fallback
  return a.grooopies < b.grooopies ? 'a' : 'b'
}
export const ttmcTurnOrder = (round: number): [Side, Side] => round % 2 === 0 ? ['b', 'a'] : ['a', 'b']
export const activeTtmcSide = (game: TtmcGame): Side | null => game.state === 'running'
  ? ttmcTurnOrder(game.roundNumber).find((side) => !game.teams[side].submitted) ?? null
  : null
export const isGameId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
export const isRound = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const statuses: MatchStatus[] = ['creating', 'joining', 'waiting', 'playing', 'revealed', 'finished', 'error', 'cancelled']
const isMatchStatus = (value: unknown): value is MatchStatus => statuses.includes(value as MatchStatus)
const isNullableNumber = (value: unknown): value is number | null => value === null || (typeof value === 'number' && Number.isFinite(value))
const isCurrentRound = (value: unknown): value is number | null => value === null || (Number.isSafeInteger(value) && (value as number) >= -1)
const isMatchTeam = (value: unknown): value is MatchTeam => isRecord(value) && typeof value.name === 'string' &&
  typeof value.accountId === 'string' && Array.isArray(value.roster) && value.roster.every((item) => typeof item === 'string')
const isLivePlayer = (value: unknown): value is LivePlayer => isRecord(value) && isNullableNumber(value.id) &&
  typeof value.isConnected === 'boolean' && typeof value.isGameMaster === 'boolean' && isNullableNumber(value.score)
const isLiveScore = (value: unknown): value is LiveScore => isRecord(value) && isNullableNumber(value.id) &&
  typeof value.isReady === 'boolean' && isNullableNumber(value.answer) && isNullableNumber(value.delta) && typeof value.submitted === 'boolean'
const isLiveGame = (value: unknown): value is LiveGame => isRecord(value) && isGameId(value.id) &&
  (value.state === null || typeof value.state === 'string') && isCurrentRound(value.currentRound) &&
  isNullableNumber(value.questionDurationSeconds) && isNullableNumber(value.questionDeadlineAt) &&
  (value.category === null || typeof value.category === 'string') && (value.question === null || typeof value.question === 'string') &&
  typeof value.showAnswer === 'boolean' && isNullableNumber(value.answer) && Array.isArray(value.scores) && value.scores.every(isLiveScore)

export function isTtmcQuestion(value: unknown): value is TtmcQuestion {
  if (!isRecord(value) || typeof value.type !== 'string' || typeof value.prompt !== 'string') return false
  if (value.type === 'bool' || value.type === 'oneword') return true
  if (value.type === 'qcm') return Array.isArray(value.options) && value.options.every((item) => typeof item === 'string') && isRound(value.selectionCount) && value.selectionCount > 0
  if (value.type === 'words') return Array.isArray(value.candidates) && value.candidates.every((item) => typeof item === 'string') && isRound(value.answerWordCount) && value.answerWordCount > 0
  return value.type === 'number' && typeof value.min === 'number' && typeof value.max === 'number' && typeof value.step === 'number' &&
    Number.isFinite(value.min) && Number.isFinite(value.max) && Number.isFinite(value.step) && value.min <= value.max && value.step > 0
}
function isTtmcTeam(value: unknown, finished: boolean) {
  return isRecord(value) && isNullableNumber(value.difficulty) &&
    (value.difficulty === null || (isRound(value.difficulty) && value.difficulty >= 1 && value.difficulty <= 10)) &&
    typeof value.submitted === 'boolean' && (value.success === null || typeof value.success === 'boolean') &&
    isNullableNumber(value.points) && (value.question === null || isTtmcQuestion(value.question)) &&
    (value.officialAnswer === null || typeof value.officialAnswer === 'string' ||
      (Array.isArray(value.officialAnswer) && value.officialAnswer.every((item) => typeof item === 'string')) ||
      (isRecord(value.officialAnswer) && typeof value.officialAnswer.value === 'number' && typeof value.officialAnswer.tolerance === 'number')) &&
    (finished || (value.success === null && value.points === null && value.officialAnswer === null))
}
const isTtmcGame = (value: unknown): value is TtmcGame => isRecord(value) && value.mode === 'ttmc' && isGameId(value.id) &&
  isRound(value.roundNumber) && isRound(value.totalRounds) && (value.state === 'running' || value.state === 'finished' || value.state === 'unknown') &&
  (value.category === null || typeof value.category === 'string') && (value.title === null || typeof value.title === 'string') &&
  isRecord(value.teams) && isTtmcTeam(value.teams.a, value.state === 'finished') && isTtmcTeam(value.teams.b, value.state === 'finished')
export const isLiveMatch = (value: unknown): value is LiveMatch => isRecord(value) && typeof value.id === 'string' &&
  isMatchStatus(value.status) && (isLiveStatus(value.status) || isTerminalStatus(value.status)) && isRecord(value.party) && typeof value.party.state === 'string' &&
  isRound(value.party.playerCount) && Array.isArray(value.players) && value.players.every(isLivePlayer) &&
  isRecord(value.teams) && isMatchTeam(value.teams.a) && isMatchTeam(value.teams.b) &&
  (value.gameMode === 'proximo' || value.gameMode === 'ttmc') &&
  (value.game === null || (value.gameMode === 'proximo' ? isLiveGame(value.game) : isTtmcGame(value.game))) &&
  typeof value.connected === 'boolean'

export function ttmcAnswerValue(question: TtmcQuestion, answer: TtmcAnswer | undefined) {
  return answer ?? (question.type === 'number' ? question.min : undefined)
}
export function isCompleteTtmcAnswer(question: TtmcQuestion, value: TtmcAnswer | undefined) {
  if (question.type === 'bool') return typeof value === 'boolean'
  if (question.type === 'qcm') return Array.isArray(value) && value.length === question.selectionCount
  if (question.type === 'words') return Array.isArray(value) && value.length === question.answerWordCount
  if (question.type === 'oneword') return typeof value === 'string' && value.trim().length > 0
  return typeof value === 'number' && Number.isFinite(value)
}
