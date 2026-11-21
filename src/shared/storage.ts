import type { Calibration, DataMode, Measurement } from './model'

export interface CalibrationStore {
  load(): Promise<Record<string, Calibration>>
  save(calibrations: Record<string, Calibration>): Promise<void>
}
export interface SessionSummary {
  id: string
  name: string
  startedAt: string
  rows: number
  chunks: number
  status: 'recording' | 'complete' | 'error'
  error: string | null
}
export interface RecordingStorage {
  create(session: SessionSummary): Promise<void>
  append(session: SessionSummary, index: number, text: string): Promise<void>
  finalize(session: SessionSummary): Promise<void>
  list(): Promise<SessionSummary[]>
  chunks(id: string): AsyncIterable<string>
}
export interface SessionRecorder {
  readonly active: boolean
  path: string | null
  rows: number
  error: string | null
  start(name: string, metadata: unknown, mode?: DataMode): Promise<void>
  append(record: unknown): boolean
  measurement(measurement: Measurement): void
  stop(): Promise<void>
}
