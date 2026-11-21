import { describe, expect, it } from 'vitest'
import { planPitotMove } from '../src/domain/pitot-motion'
import { PITOT_LIMITS_MM, pitotActionSchema } from '../src/shared/pitot'

describe('full Pitot travel', () => {
  it('accepts both full 360 mm axes without swapping, rejecting values just outside either end', () => {
    expect(pitotActionSchema.parse({ type: 'move', x: 360, y: 360 })).toEqual({
      type: 'move',
      x: 360,
      y: 360,
    })
    for (const [x, y] of [
      [360.001, 0],
      [0, 360.001],
      [-0.001, 0],
      [0, -0.001],
      [NaN, 0],
      [0, Infinity],
    ])
      expect(pitotActionSchema.safeParse({ type: 'move', x, y }).success).toBe(false)
    expect(pitotActionSchema.parse({ type: 'move', x: 123.456, y: 45.678 })).toMatchObject({
      x: 123.46,
      y: 45.68,
    })
  })
  it('slows departure and arrival at the ends without slowing travel along a stationary home axis', () => {
    const moves = planPitotMove({ x: 0, y: 0 }, { x: 360, y: 0 }, PITOT_LIMITS_MM)
    expect(moves.map(({ x, y, feedMmMin }) => ({ x, y, feedMmMin }))).toEqual([
      { x: 5, y: 0, feedMmMin: 300 },
      { x: 355, y: 0, feedMmMin: 4000 },
      { x: 360, y: 0, feedMmMin: 300 },
    ])
    expect(moves[1]!.timeoutMs).toBeGreaterThan(5000)
    const reverse = planPitotMove({ x: 360, y: 0 }, { x: 0, y: 0 }, PITOT_LIMITS_MM)
    expect(reverse.map((m) => m.x)).toEqual([355, 5, 0])
    expect(reverse.map((m) => m.feedMmMin)).toEqual([300, 4000, 300])
  })
  it('allows long diagonal motion sufficient time and follows a straight line', () => {
    const moves = planPitotMove({ x: 0, y: 0 }, { x: 360, y: 360 }, PITOT_LIMITS_MM)
    expect(moves.map((m) => [m.x, m.y])).toEqual([
      [5, 5],
      [355, 355],
      [360, 360],
    ])
    expect(moves[1]!.timeoutMs).toBeGreaterThan(10000)
  })
  it('stays slow along a moving axis near an end, uses cruise in the interior, and sends no no-op', () => {
    expect(
      planPitotMove({ x: 1, y: 100 }, { x: 4, y: 200 }, PITOT_LIMITS_MM).every(
        (m) => m.feedMmMin === 300,
      ),
    ).toBe(true)
    expect(
      planPitotMove({ x: 20, y: 20 }, { x: 300, y: 300 }, PITOT_LIMITS_MM).map((m) => m.feedMmMin),
    ).toEqual([4000])
    expect(planPitotMove({ x: 20, y: 20 }, { x: 20, y: 20 }, PITOT_LIMITS_MM)).toEqual([])
  })
  it('keeps every segment inside the envelope for moves to and from corners and fractional positions', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 360, y: 0 },
      { x: 0, y: 360 },
      { x: 360, y: 360 },
      { x: 2.34, y: 178.91 },
      { x: 150, y: 200 },
    ]
    for (const from of points)
      for (const target of points) {
        const moves = planPitotMove(from, target, PITOT_LIMITS_MM)
        if (from !== target) expect(moves.at(-1)).toMatchObject(target)
        for (const move of moves) {
          expect(move.x).toBeGreaterThanOrEqual(0)
          expect(move.x).toBeLessThanOrEqual(360)
          expect(move.y).toBeGreaterThanOrEqual(0)
          expect(move.y).toBeLessThanOrEqual(360)
        }
      }
    expect(() => planPitotMove({ x: 361, y: 0 }, { x: 0, y: 0 }, PITOT_LIMITS_MM)).toThrow()
  })
})
