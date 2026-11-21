import {
  CHANNELS,
  type Action,
  type Calibration,
  type Diagnostic,
  type Snapshot,
  type Measurement,
  type DaqState,
} from '../shared/model'
import { actionSchema } from '../shared/validation'
import { DaqDecoder, DeviceClock, acquisitionCommand } from '../domain/protocol'
import { fitCalibration, qualityAt, transform } from '../domain/measurements'
import { Recorder } from '../infrastructure/recording'
import { SettingsStore } from '../infrastructure/settings'
import { SerialDaqTransport, type DaqTransport } from '../infrastructure/serial'
import { FanOutput } from './fan-output'
import { FanRequestSupersededError } from '../domain/fan'
import { PitotService } from './pitot-service'
import { pitotActionSchema } from '../shared/pitot'

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const initialDaq = (): DaqState => ({
  state: 'disconnected',
  path: null,
  baudRate: 115200,
  requestedFormat: 'binary',
  format: 'binary',
  receivedBytes: 0,
  sentBytes: 0,
  lastReceivedAt: null,
  error: null,
  wireLog: [],
})

/** Owns the session. React never owns acquisition, serial state, or files. */
export class TunnelService {
  readonly pitot: PitotService
  private pitotStop: Promise<void> = Promise.resolve()
  readonly recorder = new Recorder()
  private decoder = new DaqDecoder()
  private clock = new DeviceClock()
  private measurements: Record<string, Measurement> = {}
  private lastGoodAtmosphere: Measurement | null = null
  private pressureSettlingUntil: number | null = null
  private calibrations: Record<string, Calibration> = {}
  private diagnostics: Diagnostic[] = []
  private diagnosticId = 0
  private sequence = 0
  private frameCount = 0
  private acquisition: Snapshot['acquisition'] = 'stopped'
  private periodMs = 100
  private roomTemperatureC = 22
  private actionQueue: Promise<void> = Promise.resolve()
  private disposed = false
  private clockFault = false
  private emergencyStopped = false
  private fanRevision = 0
  private lastTransmitAt = 0
  private readonly fan: FanOutput
  private sourceVersion = 0
  private daq = initialDaq()
  private transport: DaqTransport | null = null
  private wireSequence = 0
  private noDataTimer: ReturnType<typeof setTimeout> | undefined
  constructor(
    private readonly settings: SettingsStore,
    private readonly options: {
      transportFactory?: () => DaqTransport
      commandSpacingMs?: number
      fanAckTimeoutMs?: number
      pitotOptions?: ConstructorParameters<typeof PitotService>[0]
    } = {},
  ) {
    this.fan = new FanOutput((command) => this.transmit(command), options.fanAckTimeoutMs)
    this.pitot = new PitotService(options.pitotOptions, (message) =>
      this.diagnostic('info', message),
    )
  }
  async initialize(): Promise<void> {
    try {
      this.calibrations = await this.settings.load()
    } catch (error) {
      this.diagnostic(
        'error',
        `Saved hardware calibration could not be loaded: ${String(error)}. Defaults used.`,
      )
    }
    this.diagnostic(
      'info',
      'DAQ ready. Connect a board to receive binary measurements; no data is generated while disconnected.',
    )
  }
  snapshot(now = Date.now()): Snapshot {
    const measurements = Object.fromEntries(
      Object.entries(this.measurements).map(([id, m]) => [
        id,
        { ...m, quality: qualityAt(m, now, Math.max(1000, this.periodMs * 3)) },
      ]),
    )
    return structuredClone({
      pitot: this.pitot.snapshot(),
      fan: this.fan.snapshot(),
      at: now,
      airspeedAtmosphere:
        this.daq.state === 'connected' &&
        this.lastGoodAtmosphere &&
        now - this.lastGoodAtmosphere.receivedAt <= 2000
          ? this.lastGoodAtmosphere
          : null,
      pressureSettlingUntil: this.pressureSettlingUntil,
      emergencyStopped: this.emergencyStopped,
      mode: 'hardware',
      sourceVersion: this.sourceVersion,
      daq: { ...this.daq, format: this.decoder.format },
      acquisition: this.acquisition,
      samplePeriodMs: this.periodMs,
      measurements,
      diagnostics: this.diagnostics,
      frameCount: this.frameCount,
      recording: {
        active: this.recorder.active,
        path: this.recorder.path,
        rows: this.recorder.rows,
        error: this.recorder.error,
      },
      calibrations: this.calibrations,
      roomTemperatureC: this.roomTemperatureC,
    })
  }
  diagnostic(level: Diagnostic['level'], message: string): void {
    const event = { id: ++this.diagnosticId, at: Date.now(), level, message }
    this.diagnostics = [...this.diagnostics.slice(-99), event]
    this.recorder.append({ type: 'diagnostic', ...event })
  }
  private calibration(id: string): Calibration {
    return (
      this.calibrations[id] ?? {
        channelId: id,
        scale: 1,
        offset: 0,
        version: 0,
        unit: CHANNELS.find((c) => c.id === id)!.unit,
      }
    )
  }
  ingest(chunk: Buffer, receivedAt = Date.now()): void {
    if (!this.transport || !['connecting', 'connected'].includes(this.daq.state)) return
    this.daq.receivedBytes += chunk.length
    this.daq.lastReceivedAt = receivedAt
    this.wire('rx', chunk, receivedAt)
    for (const packet of this.decoder.push(chunk)) {
      if (packet.type === 'diagnostic') {
        this.fan.message(packet.message)
        this.diagnostic(packet.level, packet.message)
        continue
      }
      // A sample clock fault must never suppress DAC acknowledgments or prevent a zero request.
      if (this.disposed || this.clockFault) continue
      let elapsedMicros: number
      try {
        elapsedMicros = this.clock.update(packet.deviceMicros)
      } catch (error) {
        this.clockFault = true
        this.acquisition = 'stopped'
        this.diagnostic('error', String(error))
        continue
      }
      this.frameCount++
      for (const channel of CHANNELS.filter((c) => c.bank === packet.bank)) {
        const raw = packet.values[channel.index]!
        const calibration = this.calibration(channel.id)
        const value = transform(raw, calibration)
        const measurement: Measurement = {
          channelId: channel.id,
          raw: Number.isFinite(raw) ? raw : null,
          ...(!Number.isFinite(raw)
            ? { rawSpecial: String(raw) as Measurement['rawSpecial'] }
            : {}),
          value,
          unit: calibration.unit,
          quality: value === null ? 'invalid' : 'good',
          deviceMicros: packet.deviceMicros,
          elapsedMicros,
          receivedAt,
          sequence: ++this.sequence,
          calibrationVersion: calibration.version,
        }
        this.measurements[channel.id] = measurement
        if (
          channel.id === 'abs_pressure' &&
          value !== null &&
          value > 0 &&
          measurement.unit === 'kPa'
        )
          this.lastGoodAtmosphere = measurement
        this.recorder.measurement(measurement)
      }
    }
  }
  async act(input: unknown): Promise<void> {
    const action = actionSchema.parse(input)
    const requestedSource = this.sourceVersion
    // Latch immediately, ahead of queued connection/start actions and any await.
    if (action.type === 'emergency-stop') {
      this.pitotStop = this.pitot
        .stop()
        .catch((error) =>
          this.diagnostic(
            'error',
            `Pitot stop: ${String(error)}. Use physical motor power cutoff.`,
          ),
        )
      if (!this.emergencyStopped) {
        this.emergencyStopped = true
        this.diagnostic(
          'warning',
          'Emergency Stop latched: requesting DAC zero and blocking nonzero output. Physical VFD Stop remains necessary; incoming measurements may continue.',
        )
      }
    }
    const revision =
      action.type === 'fan-output' || action.type === 'emergency-stop'
        ? ++this.fanRevision
        : this.fanRevision
    const operation = this.actionQueue
      .catch(() => {})
      .then(async () => {
        if (this.disposed) throw new Error('Session is closing')
        if (
          action.type === 'fan-output' &&
          action.percent > 0 &&
          requestedSource !== this.sourceVersion
        )
          throw new Error('DAQ connection changed; apply the fan percentage again')
        if (action.type === 'fan-output' && action.percent > 0 && revision !== this.fanRevision)
          throw new Error('Fan request superseded by a newer request or stop')
        await this.perform(action)
      })
    this.actionQueue = operation
    return operation
  }
  private async perform(action: Action): Promise<void> {
    const zeroOutput = action.type === 'fan-output' && action.percent === 0
    if (
      this.emergencyStopped &&
      !zeroOutput &&
      !['emergency-stop', 'emergency-reset', 'daq-disconnect'].includes(action.type)
    )
      throw new Error('Emergency Stop is latched. Reset it before sending commands.')
    if (
      !['emergency-stop', 'emergency-reset', 'daq-connect', 'daq-disconnect'].includes(
        action.type,
      ) &&
      this.daq.state !== 'connected'
    )
      throw new Error('Connect a DAQ port from Hardware first')
    switch (action.type) {
      case 'emergency-stop':
        try {
          if (this.transport && this.daq.state === 'connected') await this.fan.setPercent(0)
          else
            this.diagnostic(
              'warning',
              'No connected DAQ to verify zero. Use the physical VFD Stop.',
            )
        } finally {
          await this.pitotStop
        }
        break
      case 'fan-output':
        try {
          await this.fan.setPercent(action.percent)
        } catch (error) {
          if (error instanceof FanRequestSupersededError) throw error
          if (action.percent > 0 && this.transport && this.daq.state === 'connected') {
            this.emergencyStopped = true
            this.fanRevision++
            await this.fan
              .setPercent(0)
              .catch((stopError) =>
                this.diagnostic(
                  'error',
                  `DAC zero could not be verified: ${String(stopError)}. Use the physical VFD Stop.`,
                ),
              )
          }
          throw error
        }
        break
      case 'emergency-reset':
        this.emergencyStopped = false
        this.diagnostic(
          'info',
          'Command block reset. No board command was sent; reapply a percentage explicitly to request fan output.',
        )
        break
      case 'daq-connect':
        await this.connectDaq(action.path, action.baudRate)
        break
      case 'daq-disconnect':
        await this.disconnectDaq()
        break
      case 'acquisition':
        if (action.running && this.clockFault)
          throw new Error('Device clock fault. Restart the application to begin a new session.')
        this.periodMs = action.periodMs
        if (!this.transport || this.daq.state !== 'connected')
          throw new Error('Connect a DAQ port from Hardware first')
        await this.transmit(
          action.running ? acquisitionCommand(this.periodMs * 1000) : Buffer.from([0]),
        )
        this.acquisition = action.running ? 'running' : 'stopped'
        if (action.running) this.pressureSettlingUntil = Date.now() + 2000
        this.diagnostic('info', `DAQ acquisition ${this.acquisition} (${this.periodMs} ms).`)
        break
      case 'temperature':
        this.roomTemperatureC = action.celsius
        this.recorder.append({ type: 'temperature', celsius: action.celsius, at: Date.now() })
        break
      case 'tare': {
        const measurement = this.snapshot().measurements[action.channelId]
        if (!measurement || measurement.quality !== 'good' || measurement.raw === null)
          throw new Error('A fresh, valid measurement is required for tare')
        const old = this.calibration(action.channelId)
        await this.saveCalibration({
          ...old,
          offset: -measurement.raw * old.scale,
          version: old.version + 1,
        })
        break
      }
      case 'calibrate': {
        const fit = fitCalibration(action.points)
        await this.saveCalibration({
          channelId: action.channelId,
          ...fit,
          unit: action.unit,
          points: action.points,
          version: this.calibration(action.channelId).version + 1,
        })
        break
      }
      case 'reset-calibration':
        await this.saveCalibration({
          channelId: action.channelId,
          scale: 1,
          offset: 0,
          unit: CHANNELS.find((c) => c.id === action.channelId)!.unit,
          version: this.calibration(action.channelId).version + 1,
        })
        break
    }
  }
  private async saveCalibration(calibration: Calibration): Promise<void> {
    const next = { ...this.calibrations, [calibration.channelId]: calibration }
    await this.settings.save(next)
    this.calibrations = next
    if (calibration.channelId === 'abs_pressure') this.lastGoodAtmosphere = null
    this.recorder.append({ type: 'calibration', at: Date.now(), calibration })
    this.diagnostic(
      'info',
      `${calibration.channelId} calibration v${calibration.version} saved for future samples.`,
    )
  }
  private requireSourceSwitch(): void {
    if (this.recorder.active) throw new Error('Stop recording before changing the data source')
  }
  private resetSource(): void {
    this.sourceVersion++
    this.acquisition = 'stopped'
    this.measurements = {}
    this.lastGoodAtmosphere = null
    this.pressureSettlingUntil = null
    this.frameCount = 0
    this.sequence = 0
    this.clockFault = false
    this.clock = new DeviceClock()
    this.decoder = new DaqDecoder()
    this.daq = initialDaq()
  }
  private wire(direction: 'rx' | 'tx', chunk: Buffer, at = Date.now()): void {
    const preview = chunk.subarray(0, 512)
    this.daq.wireLog = [
      ...this.daq.wireLog.slice(-79),
      {
        id: ++this.wireSequence,
        at,
        direction,
        bytes: chunk.length,
        hex:
          preview
            .toString('hex')
            .match(/.{1,2}/g)
            ?.join(' ') ?? '',
        text: preview
          .toString('latin1')
          .replace(
            /[^\x20-\x7e\r\n\t]/g,
            (character) => `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`,
          ),
        truncated: chunk.length > preview.length,
      },
    ]
    this.recorder.append({ type: 'wire', direction, receivedAt: at, hex: chunk.toString('hex') })
  }
  private async transmit(data: Buffer): Promise<void> {
    const zeroDac = data.equals(Buffer.from([0x21, 0, 0]))
    const revision = this.fanRevision
    const wait = (this.options.commandSpacingMs ?? 250) - (Date.now() - this.lastTransmitAt)
    if (wait > 0) await delay(wait)
    if (data[0] === 0x21 && !zeroDac && revision !== this.fanRevision)
      throw new FanRequestSupersededError('Fan request superseded before transmission')
    // Recheck after pacing; Emergency Stop can latch during this await.
    if (this.emergencyStopped && !zeroDac)
      throw new Error('Emergency Stop blocks outgoing board commands except DAC zero')
    if (!(
      (data[0] === 0 && data.length === 1) ||
      (data[0] === 1 && data.length === 5) ||
      (data[0] === 0x21 && data.length === 3 && data.readUInt16BE(1) <= 3000)
    ))
      throw new Error('Unsupported live DAQ command')
    if (!this.transport) throw new Error('DAQ serial port is not connected')
    this.wire('tx', data)
    this.lastTransmitAt = Date.now()
    try {
      await this.transport.write(data)
      this.daq.sentBytes += data.length
    } catch (error) {
      this.transportLost(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }
  private markDisconnected(): void {
    this.fan.reset()
    this.acquisition = 'stopped'
    for (const measurement of Object.values(this.measurements)) measurement.quality = 'stale'
    if (this.noDataTimer) clearTimeout(this.noDataTimer)
    void this.recorder.stop().catch((error) => this.diagnostic('error', String(error)))
  }
  private transportLost(error: Error): void {
    if (this.daq.state === 'error') return
    const transport = this.transport
    this.transport = null
    this.markDisconnected()
    this.daq.state = 'error'
    this.daq.error = error.message
    this.diagnostic('error', `DAQ connection lost: ${error.message}`)
    void transport?.close().catch(() => {})
  }
  private async disconnectDaq(): Promise<void> {
    let failure: unknown
    if (this.transport && this.daq.state === 'connected' && !this.emergencyStopped) {
      try {
        await this.fan.setPercent(0)
        await this.transmit(Buffer.from([0]))
      } catch (error) {
        failure = error
      }
    }
    if (this.transport && this.daq.state === 'connected' && this.emergencyStopped) {
      try {
        await this.fan.setPercent(0)
      } catch (error) {
        failure = error
      }
    }
    const transport = this.transport
    this.transport = null
    try {
      await transport?.close()
    } finally {
      this.markDisconnected()
      this.daq.state = failure ? 'error' : 'disconnected'
      if (failure) this.daq.error = String(failure)
    }
    if (failure) throw failure
  }
  private async connectDaq(path: string, baudRate: number): Promise<void> {
    this.requireSourceSwitch()
    await this.disconnectDaq()
    this.resetSource()
    this.daq = { ...initialDaq(), state: 'connecting', path, baudRate }
    const transport = this.options.transportFactory?.() ?? new SerialDaqTransport()
    this.transport = transport
    try {
      await transport.open(
        { path, baudRate },
        {
          data: (chunk) => {
            if (this.transport === transport) this.ingest(chunk)
          },
          error: (error) => {
            if (this.transport === transport) this.transportLost(error)
          },
          close: () => {
            if (this.transport === transport)
              this.transportLost(new Error('Serial port closed or USB device was disconnected'))
          },
        },
      )
      if (this.transport !== transport) throw new Error('DAQ disconnected during startup')
      this.daq.state = 'connected'
      await delay(250)
      // Begin every connection at acknowledged zero; never restore a previous percentage.
      let zeroVerified = false
      try {
        await this.fan.setPercent(0)
        zeroVerified = true
      } catch (error) {
        // A missing DAC acknowledgment is a fan fault, not proof of lost USB or VFD state.
        if (this.transport !== transport || this.daq.state !== 'connected') throw error
        this.diagnostic(
          'warning',
          `Fan output unavailable: ${String(error)}. Sensor acquisition will continue; fan controls stay disabled.`,
        )
      }
      // ALL_MEASURE resets all bank states itself. Do not queue a preceding STOP:
      // the firmware reads all pending bytes as one command's arguments during startup.
      await this.transmit(acquisitionCommand(this.periodMs * 1000))
      this.acquisition = 'running'
      this.pressureSettlingUntil = Date.now() + 2000
      this.diagnostic(
        'info',
        `DAQ ${path} connected at ${baudRate} baud, 8N1. ${zeroVerified ? 'DAC zero verified.' : 'DAC zero unverified; fan controls disabled.'} Binary sensor acquisition started independently of VFD run state.`,
      )
      this.noDataTimer = setTimeout(() => {
        if (
          this.daq.state === 'connected' &&
          this.acquisition === 'running' &&
          this.frameCount === 0
        )
          this.diagnostic(
            'warning',
            `No decoded measurements after 4 seconds (${this.daq.receivedBytes} bytes received). Inspect Raw serial and response format.`,
          )
      }, 4000)
    } catch (error) {
      this.transportLost(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }
  async dispose(): Promise<void> {
    this.disposed = true
    await this.pitot.disconnect().catch((error) => this.diagnostic('error', String(error)))
    await this.actionQueue.catch(() => {})
    this.acquisition = 'stopped'
    try {
      await this.disconnectDaq()
    } finally {
      await this.recorder.stop()
    }
  }
  async actPitot(input: unknown): Promise<void> {
    const action = pitotActionSchema.parse(input)
    if (this.disposed) throw Error('Session is closing')
    if (this.emergencyStopped && !['stop', 'disconnect'].includes(action.type))
      throw Error('Reset Emergency Stop before operating the Pitot')
    await this.pitot.act(action)
  }
}
