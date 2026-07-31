import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { type JsonObject, type SocketFrame, SharedState } from '../../worker/shared-state'

interface ProtocolRecord {
  sequence: number
  role: 'host' | 'guest'
  direction: 'in' | 'out'
  frame: SocketFrame
}

interface ProtocolFixture {
  version: number
  matchId: string
  records: ProtocolRecord[]
}

const fixture = JSON.parse(readFileSync(
  new URL('../fixtures/grooop/proximo-production.json', import.meta.url),
  'utf8',
)) as ProtocolFixture

function object(value: unknown): JsonObject {
  expect(value).toBeTruthy()
  expect(Array.isArray(value)).toBe(false)
  expect(typeof value).toBe('object')
  return value as JsonObject
}

describe('sanitized production Proximo fixture', () => {
  it('replays the real app-0 game and app-1 score schema', () => {
    const shared = new SharedState()
    const hostFrames = fixture.records.filter((record) =>
      record.role === 'host' && record.direction === 'in' &&
      (record.frame.t === '@SO' || record.frame.t === '@SL'),
    )

    for (const record of hostFrames) expect(shared.apply(record.frame)).toBe(true)

    const game = object(shared.list(0, 'games')[0])
    expect(game).toMatchObject({
      id: 1,
      gameName: 'proximo',
      state: 'finished',
      currentRound: 0,
      category: 'Sport',
      question: 'Combien de points faut-il au minimum pour gagner un set au tennis ?',
      answer: 6,
      showAnswer: true,
    })
    expect(shared.list(1, 'scores')).toEqual([
      expect.objectContaining({
        id: 101,
        isReady: true,
        answer: 0,
        answerDelta: -6,
        timeDelta: 151,
        won: 2,
      }),
      expect.objectContaining({
        id: 202,
        isReady: true,
        answer: 0,
        answerDelta: -6,
        timeDelta: 197,
        won: 1,
      }),
    ])
    expect(shared.list(0, 'players')).toEqual([
      expect.objectContaining({ id: 101, score: 2 }),
      expect.objectContaining({ id: 202, score: 1 }),
    ])
  })

  it('keeps the question unrevealed after both deltas and before showAnswer', () => {
    const shared = new SharedState()
    const framesBeforeReveal = fixture.records.filter((record) =>
      record.role === 'host' && record.direction === 'in' && record.sequence < 75 &&
      (record.frame.t === '@SO' || record.frame.t === '@SL'),
    )

    for (const record of framesBeforeReveal) expect(shared.apply(record.frame)).toBe(true)

    const game = object(shared.list(0, 'games')[0])
    const scores = shared.list(1, 'scores').map(object)
    expect(scores).toHaveLength(2)
    expect(scores.every((score) => typeof score.answerDelta === 'number')).toBe(true)
    expect(game.showAnswer === true).toBe(false)

    const revealFrame = fixture.records.find((record) => record.sequence === 75)
    expect(revealFrame).toBeDefined()
    expect(shared.apply(revealFrame!.frame)).toBe(true)
    expect(object(shared.list(0, 'games')[0]).showAnswer).toBe(true)
  })

  it('proves both ready and answer requests were correlated without force-start', () => {
    const outbound = fixture.records.filter((record) => record.direction === 'out')
    const actions = outbound.map((record) => record.frame.t)

    expect(actions.filter((action) => action === 'ready')).toHaveLength(2)
    expect(actions.filter((action) => action === 'answer')).toHaveLength(2)
    expect(actions).not.toContain('force-start')

    for (const request of outbound.filter((record) =>
      requestAction(record.frame.t) && typeof record.frame.u === 'string',
    )) {
      expect(fixture.records).toContainEqual(expect.objectContaining({
        role: request.role,
        direction: 'in',
        frame: expect.objectContaining({ t: request.frame.t, u: request.frame.u }),
      }))
    }
  })

  it('contains only pseudonymized correlations, references, and identities', () => {
    const encoded = JSON.stringify(fixture)
    expect(encoded).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)

    for (const record of fixture.records) {
      if (typeof record.frame.u === 'string') expect(record.frame.u).toMatch(/^request-\d+$/)
      assertSanitized(record.frame)
    }
  })
})

function assertSanitized(value: unknown, key = ''): void {
  if (typeof value === 'string') {
    if ((key === 'k' || key === '__') && value.startsWith('@')) expect(value).toMatch(/^@ref-\d+$/)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) assertSanitized(item)
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [childKey, childValue] of Object.entries(value)) assertSanitized(childValue, childKey)
}

function requestAction(action: string | undefined): boolean {
  return action === 'ready' || action === 'answer'
}
