import type { SpeedUnit } from '../domain/measurements'
export interface AirspeedSources {
  pitot: string
  ring: string
}
export interface PitotTarget {
  x: number
  y: number
}
export interface OperatorSettings {
  sources: AirspeedSources
  unit: SpeedUnit
  requestedPercent: number
  target: PitotTarget
}
