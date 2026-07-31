import { describe, expect, it } from 'vitest'
import { SharedState, type SocketFrame } from '../../worker/shared-state'

function apply(state: SharedState, t: '@SO' | '@SL', d: Record<string, unknown>): boolean {
  return state.apply({ a: 7, t, d })
}

describe('SharedState recovered reducer', () => {
  it('creates, updates, and removes a shared object', () => {
    const state = new SharedState()

    expect(apply(state, '@SO', { a: 'C', k: 'player', v: { name: 'Ada', score: 1 } })).toBe(true)
    expect(apply(state, '@SO', { a: 'M', k: 'player', n: 'score', v: 2 })).toBe(true)
    expect(state.get(7, 'player')).toEqual({ name: 'Ada', score: 2 })

    expect(apply(state, '@SO', { a: 'R', k: 'player', n: 'name' })).toBe(true)
    expect(state.get(7, 'player')).toEqual({ score: 2 })

    expect(apply(state, '@SO', { a: 'D', k: 'player' })).toBe(true)
    expect(state.get(7, 'player')).toBeUndefined()
  })

  it('creates, appends, patches, replaces, and removes shared list entries', () => {
    const state = new SharedState()

    expect(apply(state, '@SL', { a: 'C', k: 'players', v: [{ name: 'Ada', score: 1 }] })).toBe(true)
    expect(apply(state, '@SL', { a: 'A', k: 'players', v: { name: 'Lin', score: 3 } })).toBe(true)
    expect(apply(state, '@SL', { a: 'P', k: 'players', n: 0, p: 'score', v: 2 })).toBe(true)
    expect(apply(state, '@SL', { a: 'M', k: 'players', n: 1, v: { name: 'Grace', score: 4 } })).toBe(true)
    expect(state.get(7, 'players')).toEqual([
      { name: 'Ada', score: 2 },
      { name: 'Grace', score: 4 },
    ])

    expect(apply(state, '@SL', { a: 'R', k: 'players', n: 0 })).toBe(true)
    expect(state.get(7, 'players')).toEqual([{ name: 'Grace', score: 4 }])

    expect(apply(state, '@SL', { a: 'D', k: 'players' })).toBe(true)
    expect(state.get(7, 'players')).toBeUndefined()
  })

  it('dereferences shared-list references and omits missing references', () => {
    const state = new SharedState()
    apply(state, '@SO', { a: 'C', k: 'player-1', v: { name: 'Ada' } })
    apply(state, '@SL', {
      a: 'C',
      k: 'roster',
      v: [{ __: 'player-1' }, { __: 'missing' }, null, 'spectator'],
    })

    expect(state.list(7, 'roster')).toEqual([{ name: 'Ada' }, null, 'spectator'])
  })

  it('rejects entities carried by the wrong frame family', () => {
    const state = new SharedState()

    expect(apply(state, '@SO', { a: 'C', k: 'list', v: [] })).toBe(false)
    expect(apply(state, '@SL', { a: 'C', k: 'object', v: {} })).toBe(false)
    expect(apply(state, '@SO', { a: 'C', k: 'object', v: {} })).toBe(true)
    expect(apply(state, '@SL', { a: 'D', k: 'object' })).toBe(false)
    expect(state.get(7, 'object')).toEqual({})
  })

  it('rejects invalid list indices without mutating the list', () => {
    const state = new SharedState()
    apply(state, '@SL', { a: 'C', k: 'values', v: [{ score: 1 }] })

    expect(apply(state, '@SL', { a: 'R', k: 'values', n: -1 })).toBe(false)
    expect(apply(state, '@SL', { a: 'M', k: 'values', n: 1, v: 'extra' })).toBe(false)
    expect(apply(state, '@SL', { a: 'P', k: 'values', n: 0.5, p: 'score', v: 2 })).toBe(false)
    expect(state.get(7, 'values')).toEqual([{ score: 1 }])
  })

  it('skips invalid or missing updates without changing recovered state', () => {
    const state = new SharedState()
    const create: SocketFrame = { a: 7, t: '@SO', d: { a: 'C', k: 'player', v: { score: 1 } } }
    expect(state.apply(create)).toBe(true)

    expect(apply(state, '@SO', { a: 'M', k: 'missing', n: 'score', v: 9 })).toBe(false)
    expect(apply(state, '@SO', { a: 'M', k: 'player', v: 9 })).toBe(false)
    expect(state.apply({ a: 8, t: '@SO', d: { a: 'M', k: 'player', n: 'score', v: 9 } })).toBe(false)

    expect(state.get(7, 'player')).toEqual({ score: 1 })
    expect(state.get(7, 'missing')).toBeUndefined()
    expect(state.get(8, 'player')).toBeUndefined()
  })

  it('rejects malformed frame roots instead of throwing', () => {
    const state = new SharedState()

    expect(state.apply(null as unknown as SocketFrame)).toBe(false)
    expect(state.apply([] as unknown as SocketFrame)).toBe(false)
    expect(state.apply({ a: {}, t: '@SO', d: { a: 'C', k: 'player', v: {} } } as unknown as SocketFrame)).toBe(false)
    expect(state.get(7, 'player')).toBeUndefined()
  })
})
