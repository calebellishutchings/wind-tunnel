import type { PitotAction, PitotState } from './pitot'
import type { SessionSummary } from './storage'
export type BankId = 2 | 3 | 4 | 5 | 6
export type Quality = 'good' | 'invalid' | 'stale' | 'missing'
export type DataMode = 'hardware'
export type WireFormat = 'binary'
export interface SerialEntry {
  id: number
  at: number
  direction: 'rx' | 'tx'
  bytes: number
  hex: string
  text: string
  truncated: boolean
}
export interface DaqState {
  state: 'disconnected' | 'connecting' | 'connected' | 'error'
  path: string | null
  baudRate: number
  requestedFormat: WireFormat
  format: 'binary'
  receivedBytes: number
  sentBytes: number
  lastReceivedAt: number | null
  error: string | null
  wireLog: SerialEntry[]
}
export interface Channel {
  id: string
  name: string
  bank: BankId
  index: number
  unit: string
  group: 'Bridge' | 'Temperature' | 'Atmosphere' | 'Pressure' | 'Array'
}
export const CHANNELS: Channel[] = [
  ...Array.from({ length: 4 }, (_, i): Channel => ({
    id: `strain${i + 1}`,
    name: `Bridge ${i + 1}`,
    bank: 2,
    index: i,
    unit: 'raw',
    group: 'Bridge',
  })),
  ...Array.from({ length: 4 }, (_, i): Channel => ({
    id: `temp${i + 1}`,
    name: `Thermocouple ${i + 1}`,
    bank: 3,
    index: i,
    unit: '°C',
    group: 'Temperature',
  })),
  {
    id: 'abs_pressure',
    name: 'Atmospheric pressure',
    bank: 4,
    index: 0,
    unit: 'kPa',
    group: 'Atmosphere',
  },
  ...Array.from({ length: 4 }, (_, i): Channel => ({
    id: `press${i + 1}`,
    name: `Differential ${i + 1}`,
    bank: 5,
    index: i,
    unit: 'Pa',
    group: 'Pressure',
  })),
  ...Array.from({ length: 24 }, (_, i): Channel => ({
    id: `array${i + 1}`,
    name: `Pressure tap ${String(i + 1).padStart(2, '0')}`,
    bank: 6,
    index: i,
    unit: 'Pa',
    group: 'Array',
  })),
]
/** Keep canonical units stable; bridge counts can be calibrated into force. */
export function allowedCalibrationUnits(channelId: string): string[] {
  const channel = CHANNELS.find((entry) => entry.id === channelId)
  if (!channel) return []
  return channel.group === 'Bridge' ? ['raw', 'N'] : [channel.unit]
}
export interface Measurement {
  channelId: string
  raw: number | null
  rawSpecial?: 'NaN' | 'Infinity' | '-Infinity'
  value: number | null
  unit: string
  quality: Quality
  deviceMicros: number
  elapsedMicros: number
  receivedAt: number
  sequence: number
  calibrationVersion: number
}
export interface Calibration {
  channelId: string
  scale: number
  offset: number
  unit: string
  version: number
  points?: { raw: number; reference: number }[]
}
export interface Diagnostic {
  id: number
  at: number
  level: 'info' | 'warning' | 'error'
  message: string
}

export interface FanState {
  status: 'unverified' | 'sending' | 'confirmed' | 'error'
  requestedMillivolts: number
  confirmedMillivolts: number | null
  error: string | null
}
export interface Snapshot {
  disconnecting: boolean
  pitot: PitotState
  fan: FanState
  at: number
  airspeedAtmosphere: Measurement | null
  pressureSettlingUntil: number | null
  emergencyStopped: boolean
  mode: DataMode
  sourceVersion: number
  daq: DaqState
  acquisition: 'stopped' | 'running'
  samplePeriodMs: number
  measurements: Record<string, Measurement>
  diagnostics: Diagnostic[]
  frameCount: number
  recording: { active: boolean; path: string | null; rows: number; error: string | null }
  calibrations: Record<string, Calibration>
  roomTemperatureC: number
}
export interface PortInfo {
  path: string
  manufacturer?: string
  serialNumber?: string
  vendorId?: string
  productId?: string
}
export type Action =
  | { type: 'fan-output'; percent: number }
  | { type: 'emergency-stop' }
  | { type: 'emergency-reset' }
  | { type: 'daq-connect'; path: string; baudRate: number }
  | { type: 'daq-disconnect' }
  | { type: 'acquisition'; running: boolean; periodMs: number }
  | { type: 'temperature'; celsius: number }
  | { type: 'tare'; channelId: string }
  | {
      type: 'calibrate'
      channelId: string
      points: { raw: number; reference: number }[]
      unit: string
    }
  | { type: 'reset-calibration'; channelId: string }
export type Result<T = void> = { ok: true; value: T } | { ok: false; error: string }
export interface TunnelApi {
  requestPort(kind: 'daq' | 'pitot'): Promise<Result<PortInfo | null>>
  disconnect(): Promise<Result>
  listRecordings(): Promise<Result<SessionSummary[]>>
  saveRecording(id: string | null, format: 'jsonl' | 'csv'): Promise<Result<string | null>>
  importCalibrations(): Promise<Result>
  exportCalibrations(): Promise<Result<string | null>>
  pitotAct(action: PitotAction): Promise<Result>
  snapshot(): Promise<Snapshot>
  subscribe(callback: (snapshot: Snapshot) => void): () => void
  act(action: Action): Promise<Result>
  listPorts(): Promise<Result<PortInfo[]>>
  startRecording(): Promise<Result<string | null>>
  stopRecording(): Promise<Result>
  exportCsv(): Promise<Result<string | null>>
}
