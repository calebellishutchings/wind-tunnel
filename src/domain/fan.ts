/** Manual reference percentage, not calibrated airspeed. 100% is 3.000 V before amplification. */
export class FanRequestSupersededError extends Error {}
export function fanMillivolts(percent: number): number {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100)
    throw new Error('Fan percentage must be between 0 and 100')
  return Math.round(percent * 30)
}
