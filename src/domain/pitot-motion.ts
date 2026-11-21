import { PITOT_FEED_MM_MIN } from '../shared/pitot'

export interface PitotPoint {
  x: number
  y: number
}
export interface PitotMove extends PitotPoint {
  feedMmMin: number
  timeoutMs: number
}
export const PITOT_END_ZONE_MM = 5
export const PITOT_END_FEED_MM_MIN = 300

/** Follow the requested straight line, slowing only moving axes near either rail end. */
export function planPitotMove(
  from: PitotPoint,
  target: PitotPoint,
  limits: PitotPoint,
): PitotMove[] {
  for (const point of [from, target]) {
    if (
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      point.x < 0 ||
      point.y < 0 ||
      point.x > limits.x ||
      point.y > limits.y
    )
      throw Error('Pitot position is outside the travel limits; home before moving')
  }
  const delta = { x: target.x - from.x, y: target.y - from.y }
  if (Math.hypot(delta.x, delta.y) < 0.005) return []
  const cuts = new Set([0, 1])
  for (const axis of ['x', 'y'] as const) {
    if (delta[axis] === 0) continue
    for (const boundary of [PITOT_END_ZONE_MM, limits[axis] - PITOT_END_ZONE_MM]) {
      const t = (boundary - from[axis]) / delta[axis]
      if (t > 0 && t < 1) cuts.add(t)
    }
  }
  const sorted = [...cuts].sort((a, b) => a - b)
  const moves: PitotMove[] = []
  let previous = from
  for (let i = 1; i < sorted.length; i++) {
    const t = sorted[i]!,
      midpoint = (sorted[i - 1]! + t) / 2
    const endZone = (['x', 'y'] as const).some((axis) => {
      const value = from[axis] + delta[axis] * midpoint
      return (
        delta[axis] !== 0 && (value < PITOT_END_ZONE_MM || value > limits[axis] - PITOT_END_ZONE_MM)
      )
    })
    const next =
      t === 1
        ? target
        : {
            x: Math.round((from.x + delta.x * t) * 100) / 100,
            y: Math.round((from.y + delta.y * t) * 100) / 100,
          }
    const distance = Math.hypot(next.x - previous.x, next.y - previous.y)
    if (distance < 0.005) continue
    const feedMmMin = endZone ? PITOT_END_FEED_MM_MIN : PITOT_FEED_MM_MIN
    // Long diagonal traverses exceed the old fixed five-second M400 deadline.
    moves.push({
      ...next,
      feedMmMin,
      timeoutMs: Math.max(5000, Math.ceil((distance / (feedMmMin / 60)) * 1000) + 3000),
    })
    previous = next
  }
  return moves
}
