import type { Calibration, Measurement, Snapshot } from '../shared/model'
export type SpeedUnit = 'mph' | 'm/s'
export const MIN_AIRSPEED_DIFFERENTIAL_PA = -3
export const speedIn = (metersPerSecond: number, unit: SpeedUnit): number =>
  unit === 'mph' ? metersPerSecond * 2.2369362920544 : metersPerSecond
/** A bounded last-valid atmospheric input bridges measured sensor NaNs, never pressure NaNs. */
export function snapshotAirspeed(snapshot: Snapshot, channelId: string) {
  if (snapshot.pressureSettlingUntil !== null && snapshot.at < snapshot.pressureSettlingUntil)
    return null
  return measuredAirspeed(
    snapshot.measurements[channelId],
    snapshot.airspeedAtmosphere ?? undefined,
    snapshot.roomTemperatureC,
  )
}
export function airspeedStatus(snapshot: Snapshot, channelId: string): string {
  if (snapshot.pressureSettlingUntil !== null && snapshot.at < snapshot.pressureSettlingUntil)
    return 'Pressure sensors settling (2 seconds); original readings remain in raw graphs and logs.'
  const pressure = snapshot.measurements[channelId]
  if (
    pressure?.quality === 'good' &&
    pressure.value !== null &&
    pressure.value < MIN_AIRSPEED_DIFFERENTIAL_PA
  )
    return 'Differential pressure is below −3 Pa; airspeed unavailable. Check polarity and fan-off tare in Calibration.'
  if (!snapshot.airspeedAtmosphere)
    return 'No valid atmospheric sample within 2 seconds; airspeed unavailable.'
  if (!snapshotAirspeed(snapshot, channelId))
    return 'Requires a fresh, finite differential pressure in Pa.'
  const held = snapshot.measurements.abs_pressure?.sequence !== snapshot.airspeedAtmosphere.sequence
  const clamp =
    pressure && pressure.value !== null && pressure.value < 0
      ? 'Small negative differential pressure treated as 0 Pa for airspeed; raw reading unchanged. '
      : ''
  return (
    clamp +
    (held
      ? `Density uses last valid atmospheric reading (${((snapshot.at - snapshot.airspeedAtmosphere.receivedAt) / 1000).toFixed(1)} s old; limit 2 s). Latest raw input is invalid.`
      : 'Calculated from fresh differential and atmospheric pressure.')
  )
}
export function measuredAirspeed(
  pressure: Measurement | undefined,
  atmosphere: Measurement | undefined,
  temperatureC: number,
): { speed: number; density: number } | null {
  if (
    pressure?.quality !== 'good' ||
    pressure.unit !== 'Pa' ||
    atmosphere?.quality !== 'good' ||
    atmosphere.unit !== 'kPa'
  )
    return null
  return airspeed(pressure.value, atmosphere.value, temperatureC)
}
export function fitCalibration(points: { raw: number; reference: number }[]): {
  scale: number
  offset: number
} {
  if (
    points.length < 2 ||
    points.some((p) => !Number.isFinite(p.raw) || !Number.isFinite(p.reference))
  )
    throw new Error('At least two finite calibration points are required')
  const meanRaw = points.reduce((sum, p) => sum + p.raw, 0) / points.length
  const meanReference = points.reduce((sum, p) => sum + p.reference, 0) / points.length
  const variance = points.reduce((sum, p) => sum + (p.raw - meanRaw) ** 2, 0)
  if (variance < Number.EPSILON) throw new Error('Calibration raw values must differ')
  const scale =
    points.reduce((sum, p) => sum + (p.raw - meanRaw) * (p.reference - meanReference), 0) / variance
  const offset = meanReference - scale * meanRaw
  if (!Number.isFinite(scale) || !Number.isFinite(offset))
    throw new Error('Calibration fit is not finite')
  return { scale, offset }
}
export function transform(raw: number, calibration: Calibration): number | null {
  const value = raw * calibration.scale + calibration.offset
  return Number.isFinite(value) ? value : null
}
export function qualityAt(
  measurement: Measurement | undefined,
  now: number,
  staleAfterMs: number,
): Measurement['quality'] {
  if (!measurement) return 'missing'
  if (now - measurement.receivedAt > staleAfterMs) return 'stale'
  return measurement.quality
}
/** Uncorrected Bernoulli speed. No unverified static-ring area correction or force-axis mapping. */
export function airspeed(
  pressurePa: number | null,
  absoluteKpa: number | null,
  temperatureC: number,
): { speed: number; density: number } | null {
  if (
    pressurePa === null ||
    absoluteKpa === null ||
    ![pressurePa, absoluteKpa, temperatureC].every(Number.isFinite) ||
    pressurePa < MIN_AIRSPEED_DIFFERENTIAL_PA ||
    absoluteKpa <= 0 ||
    temperatureC <= -273.15
  )
    return null
  const density = (absoluteKpa * 1000) / (287.05 * (temperatureC + 273.15))
  return { density, speed: Math.sqrt((2 * Math.max(0, pressurePa)) / density) }
}
