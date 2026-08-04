export type Account = { id: string; email: string; userId: number; grooopies: number; status: string }
export type Challenge = { id: string; email: string }

export type TeamPreset = {
  id: string
  name: string
  roster: string[]
}

export type ObservedQuestion = {
  content: string
  category: string | null
  question: string
  answer: string
  firstSeenAt: string
}

export type MatchTeam = { name: string; roster: string[]; accountId: string }
export type GameMode = 'proximo' | 'ttmc'
export type TtmcContent = { slug: string; title: string }
export type TtmcCatalog = {
  owned: boolean
  contents: TtmcContent[]
  rounds: { min: number; max: number; default: number; step: number }
}
type MatchBase = {
  id: string
  status: string
  teamA: MatchTeam
  teamB: MatchTeam
  cost: number
  error: string | null
  createdAt: string
  finishedAt: string | null
}
export type Match = MatchBase & (
  | { gameMode: 'proximo'; contentSlug: string; durationMinutes: number }
  | { gameMode: 'ttmc'; ttmcContentSlugs: string[]; rounds: number }
)

type SharedMatchSetup = {
  hostAccountId: string
  teamAAccountId: string
  teamBAccountId: string
  teamA: { name: string; roster: string[] }
  teamB: { name: string; roster: string[] }
}
export type MatchSetup = SharedMatchSetup & (
  | { gameMode: 'proximo'; contentSlug: string; durationMinutes: number }
  | { gameMode: 'ttmc'; rounds: number; ttmcContentSlugs: string[] }
)

export type MatchQuote = {
  cost: number
  userCanSpend: boolean
  hostBalance: number
  guestBalance: number
}

export type LiveGame = {
  id: number
  state: string | null
  currentRound: number | null
  questionDurationSeconds: number | null
  questionDeadlineAt: number | null
  category: string | null
  question: string | null
  showAnswer: boolean
  answer: number | null
  scores: LiveScore[]
}

export type TtmcQuestion =
  | { type: 'bool'; prompt: string }
  | { type: 'qcm'; prompt: string; options: string[]; selectionCount: number }
  | { type: 'words'; prompt: string; candidates: string[]; answerWordCount: number }
  | { type: 'oneword'; prompt: string }
  | { type: 'number'; prompt: string; min: number; max: number; step: number }
export type TtmcAnswer = boolean | number | string | Array<string | number>
export type TtmcTeam = { difficulty: number | null; submitted: boolean; success: boolean | null; points: number | null; question: TtmcQuestion | null; officialAnswer: null | string | string[] | { value: number; tolerance: number } }
export type TtmcGame = { mode: 'ttmc'; id: number; roundNumber: number; totalRounds: number; state: string; category: string | null; title: string | null; teams: { a: TtmcTeam; b: TtmcTeam } }

export type LivePlayer = {
  id: number | null
  isConnected: boolean
  isGameMaster: boolean
  score: number | null
}

export type LiveScore = {
  id: number | null
  isReady: boolean
  answer: number | null
  delta: number | null
  submitted: boolean
}

type LiveMatchBase = {
  id: string
  status: string
  party: { state: string; playerCount: number }
  players: LivePlayer[]
  teams: { a: MatchTeam; b: MatchTeam }
  connected: boolean
}
export type LiveMatch = LiveMatchBase & (
  | { gameMode: 'proximo'; game: LiveGame | null }
  | { gameMode: 'ttmc'; game: TtmcGame | null }
)

export class ApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(message: string, code: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  if (init?.body != null) headers.set('Content-Type', 'application/json')
  const response = await fetch(path, { ...init, headers })
  if (!response.ok) {
    let message = `Request failed (${response.status}).`
    let code = `http-${response.status}`
    try {
      const payload = await response.json() as { error?: unknown; message?: unknown }
      if (typeof payload.error === 'string') code = payload.error
      if (typeof payload.message === 'string') message = payload.message
      else if (typeof payload.error === 'string') message = payload.error
    } catch { /* Response was not JSON. */ }
    throw new ApiError(message, code, response.status)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export const getAccounts = () => request<{ accounts: Account[] }>('/api/accounts')
export const createChallenge = (email: string) => request<{ challenge: Challenge }>('/api/accounts/challenges', { method: 'POST', body: JSON.stringify({ email }) })
export const verifyChallenge = (id: string, code: string) => request<{ account: Account }>(`/api/accounts/challenges/${encodeURIComponent(id)}/verify`, { method: 'POST', body: JSON.stringify({ code }) })
export const refreshAccount = (id: string) => request<{ account: Account }>(`/api/accounts/${encodeURIComponent(id)}/refresh`, { method: 'POST' })
export const reauthenticateAccount = (id: string) => request<{ challenge: Challenge }>(`/api/accounts/${encodeURIComponent(id)}/reauthenticate`, { method: 'POST' })
export const deleteAccount = (id: string) => request<void>(`/api/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' })
export const getTtmcCatalog = (id: string, signal?: AbortSignal) => request<TtmcCatalog>(`/api/accounts/${encodeURIComponent(id)}/shop`, { signal })
export const quoteMatch = (setup: MatchSetup, signal?: AbortSignal) => request<{ quote: MatchQuote }>('/api/matches/quote', { method: 'POST', body: JSON.stringify(setup), signal })
export const createMatch = (setup: MatchSetup, expectedCost: number, idempotencyKey: string) => request<{ match: Match }>('/api/matches', { method: 'POST', body: JSON.stringify({ ...setup, expectedCost, idempotencyKey }) })
export const getMatches = () => request<{ matches: Match[] }>('/api/matches')
export const resumeMatch = (id: string) => request<{ match: Match }>(`/api/matches/${encodeURIComponent(id)}/resume`, { method: 'POST' })
export const cancelMatch = (id: string) => request<{ match: Match }>(`/api/matches/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
export const getTeamPresets = () => request<{ presets: TeamPreset[] }>('/api/team-presets')
export const createTeamPreset = (preset: Pick<TeamPreset, 'name' | 'roster'>) => request<{ preset: TeamPreset }>('/api/team-presets', { method: 'POST', body: JSON.stringify(preset) })
export const updateTeamPreset = (id: string, preset: Pick<TeamPreset, 'name' | 'roster'>) => request<{ preset: TeamPreset }>(`/api/team-presets/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(preset) })
export const deleteTeamPreset = (id: string) => request<void>(`/api/team-presets/${encodeURIComponent(id)}`, { method: 'DELETE' })
export const getObservedQuestions = () => request<{ questions: ObservedQuestion[] }>('/api/questions')
