import { describe, expect, it } from 'vitest'
import {
  airspeed,
  fitCalibration,
  transform,
  measuredAirspeed,
  speedIn,
} from '../src/domain/measurements'
import type { Measurement } from '../src/shared/model'
import { actionSchema } from '../src/shared/validation'
import { CHANNELS } from '../src/shared/model'
describe('measurement processing', () => {
  it('derives separate pressure-based speeds, validates quality/units, and converts mph correctly', () => {
    const dp = { quality: 'good', unit: 'Pa', value: 60 } as Measurement
    const atmosphere = { quality: 'good', unit: 'kPa', value: 101.325 } as Measurement
    const pitot = measuredAirspeed(dp, atmosphere, 22)!
    const ring = measuredAirspeed({ ...dp, value: 240 }, atmosphere, 22)!
    expect(ring.speed).toBeCloseTo(pitot.speed * 2)
    expect(speedIn(10, 'mph')).toBeCloseTo(22.3693629)
    expect(speedIn(10, 'm/s')).toBe(10)
    expect(measuredAirspeed({ ...dp, quality: 'stale' }, atmosphere, 22)).toBeNull()
    expect(measuredAirspeed(dp, { ...atmosphere, unit: 'Pa' }, 22)).toBeNull()
    expect(measuredAirspeed({ ...dp, value: -1 }, atmosphere, 22)?.speed).toBe(0)
    expect(measuredAirspeed(dp, { ...atmosphere, value: null, quality: 'invalid' }, 22)).toBeNull()
  })
  it('defines unique stable identities for 37 channels', () => {
    expect(CHANNELS).toHaveLength(37)
    expect(new Set(CHANNELS.map((c) => c.id)).size).toBe(37)
  })
  it('fits raw to physical reference without an implicit kg/newton conversion', () => {
    const fit = fitCalibration([
      { raw: 1000, reference: 0 },
      { raw: 2000, reference: 9.81 },
      { raw: 3000, reference: 19.62 },
    ])
    expect(fit.scale).toBeCloseTo(0.00981)
    expect(transform(2000, { ...fit, channelId: 'strain2', version: 1, unit: 'N' })).toBeCloseTo(
      9.81,
    )
    expect(() =>
      fitCalibration([
        { raw: 1, reference: 0 },
        { raw: 1, reference: 9 },
      ]),
    ).toThrow()
  })
  it('converts absolute kPa to density and rejects invalid Bernoulli inputs', () => {
    expect(airspeed(60, 101.325, 22)?.speed).toBeCloseTo(10.0168, 2)
    expect(airspeed(0, 101.325, 22)?.speed).toBe(0)
    for (const pressure of [-3.001, NaN, Infinity, null])
      expect(airspeed(pressure, 101.325, 22)).toBeNull()
    expect(airspeed(1, 0, 22)).toBeNull()
  })
  it('clamps only small negative differential pressures for airspeed and preserves their raw values', () => {
    const atmosphere = { quality: 'good', unit: 'kPa', value: 101.325 } as Measurement
    for (const pressure of [-3, -2, -0.001, 0]) {
      const sample = { quality: 'good', unit: 'Pa', value: pressure, raw: pressure } as Measurement
      expect(measuredAirspeed(sample, atmosphere, 22)?.speed).toBe(0)
      expect(sample).toMatchObject({ value: pressure, raw: pressure })
    }
    expect(airspeed(-3.00001, 101.325, 22)).toBeNull()
    expect(airspeed(1, 101.325, 22)?.speed).toBeGreaterThan(0)
    expect(airspeed(-1, -101, 22)).toBeNull()
    expect(airspeed(-1, null, 22)).toBeNull()
  })
  it('rejects malformed actions at the process boundary', () => {
    for (const action of [
      { type: 'motor', millivolts: 3301 },
      { type: 'motor', millivolts: 1, arbitrary: true },
      { type: 'move', x: -1, y: 0 },
      { type: 'tare', channelId: 'nonexistent' },
      { type: 'temperature', celsius: NaN },
      { type: 'acquisition', running: true, periodMs: 0 },
      {
        type: 'calibrate',
        channelId: 'press1',
        unit: 'N',
        points: [
          { raw: 0, reference: 0 },
          { raw: 1, reference: 1 },
        ],
      },
    ])
      expect(actionSchema.safeParse(action).success).toBe(false)
  })
})
