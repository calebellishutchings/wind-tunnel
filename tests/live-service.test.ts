import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SettingsStore } from './support/node-settings'
import { Recorder } from './support/node-recording'
import { TunnelService } from '../src/main/tunnel-service'
import { encodeFrame } from '../src/domain/protocol'
import { FakeTransport, connect } from './helpers'
import { snapshotAirspeed } from '../src/domain/measurements'

describe('board-only session', () => {
  let directory: string
  let service: TunnelService
  let transport: FakeTransport
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ens-board-'))
    transport = new FakeTransport()
    service = new TunnelService(new SettingsStore(join(directory, 'hardware.json')), {
      recorder: new Recorder(),
      transportFactory: () => transport,
      commandSpacingMs: 0,
      fanAckTimeoutMs: 30,
    })
    await service.initialize()
  })
  afterEach(async () => {
    await service.dispose().catch(() => {})
    await rm(directory, { recursive: true, force: true })
  })
  it('starts disconnected with no measurements and rejects removed actions and ASCII configuration', async () => {
    expect(service.snapshot()).toMatchObject({
      mode: 'hardware',
      acquisition: 'stopped',
      measurements: {},
      daq: { state: 'disconnected', format: 'binary' },
    })
    service.ingest(encodeFrame(4, [101], 100))
    expect(service.snapshot().measurements).toEqual({})
    for (const action of [
      { type: 'simulation' },
      { type: 'motor', millivolts: 0 },
      { type: 'home' },
      { ...connect, format: 'ascii' },
      { ...connect, format: 'auto' },
    ])
      await expect(service.act(action)).rejects.toThrow()
    for (const action of [
      { type: 'acquisition', running: true, periodMs: 100 },
      { type: 'tare', channelId: 'press1' },
      { type: 'temperature', celsius: 25 },
    ])
      await expect(service.act(action)).rejects.toThrow('Connect a DAQ')
    expect(transport.writes).toHaveLength(0)
  })
  it('uses one idempotent acquisition command on connect and explicit stop/start commands', async () => {
    await service.act(connect)
    expect(transport.writes.map((b) => b.toString('hex'))).toEqual(['210000', '01000186a0'])
    transport.emit(encodeFrame(2, [-2618, 3207, 4856, 457], 100))
    expect(service.snapshot().measurements.strain1?.raw).toBe(-2618)
    await service.act({ type: 'acquisition', running: false, periodMs: 100 })
    await service.act({ type: 'acquisition', running: true, periodMs: 200 })
    expect(transport.writes.map((b) => b.toString('hex'))).toEqual([
      '210000',
      '01000186a0',
      '00',
      '0100030d40',
    ])
    await service.act({ type: 'daq-disconnect' })
    expect(transport.closed).toBe(true)
    expect(service.snapshot().measurements.strain1?.quality).toBe('stale')
    const count = service.snapshot().frameCount
    transport.emit(encodeFrame(4, [999], 200))
    expect(service.snapshot().frameCount).toBe(count)
  })
  it('latches Emergency Stop, requests zero, and blocks commands except further zero requests', async () => {
    await service.act(connect)
    const count = transport.writes.length
    await service.act({ type: 'emergency-stop' })
    expect(service.snapshot().emergencyStopped).toBe(true)
    transport.emit(encodeFrame(4, [101], 100))
    expect(service.snapshot().measurements.abs_pressure?.value).toBe(101)
    await expect(
      service.act({ type: 'acquisition', running: false, periodMs: 100 }),
    ).rejects.toThrow('Emergency Stop')
    await expect(service.act(connect)).rejects.toThrow('Emergency Stop')
    await service.act({ type: 'daq-disconnect' })
    expect(transport.writes.slice(count).map((b) => b.toString('hex'))).toEqual([
      '210000',
      '210000',
    ])
    await service.act({ type: 'emergency-reset' })
    expect(transport.writes).toHaveLength(count + 2)
    expect(service.snapshot().daq.state).toBe('disconnected')
    await service.act(connect)
    expect(transport.writes).toHaveLength(count + 4)
  })
  it('preempts a connection that is waiting to send its startup command', async () => {
    const connecting = service.act(connect)
    const failure = expect(connecting).rejects.toThrow('Emergency Stop')
    await new Promise((resolve) => setTimeout(resolve, 20))
    await service.act({ type: 'emergency-stop' })
    await failure
    expect(transport.writes.map((b) => b.toString('hex'))).toEqual(['210000'])
    expect(service.snapshot().emergencyStopped).toBe(true)
  })
  it('retains zeros, NaN and freshness without exposing mutable state', async () => {
    await service.act(connect)
    service.ingest(encodeFrame(5, [0, -2, NaN, 3], 100), 1000)
    const state = service.snapshot(1000)
    expect(state.measurements.press1).toMatchObject({ raw: 0, value: 0, quality: 'good' })
    expect(state.measurements.press3).toMatchObject({
      raw: null,
      rawSpecial: 'NaN',
      quality: 'invalid',
    })
    state.measurements.press1!.value = 999
    expect(service.snapshot(1000).measurements.press1?.value).toBe(0)
    expect(service.snapshot(2500).measurements.press1?.quality).toBe('stale')
  })
  it('keeps atmospheric NaNs raw while bounding the last valid density input to two seconds', async () => {
    await service.act(connect)
    const start = Date.now()
    service.ingest(encodeFrame(4, [101.325], 100), start)
    service.ingest(encodeFrame(5, [60, 120, NaN, NaN], 200), start)
    expect(snapshotAirspeed(service.snapshot(start), 'press1')).toBeNull() // Settling
    service.ingest(encodeFrame(4, [101.325], 300), start + 2100)
    service.ingest(encodeFrame(5, [60, 120, NaN, NaN], 400), start + 2200)
    service.ingest(encodeFrame(4, [NaN], 500), start + 2300)
    const held = service.snapshot(start + 2300)
    expect(held.measurements.abs_pressure).toMatchObject({
      raw: null,
      rawSpecial: 'NaN',
      quality: 'invalid',
    })
    expect(held.airspeedAtmosphere?.receivedAt).toBe(start + 2100)
    expect(snapshotAirspeed(held, 'press1')?.speed).toBeCloseTo(10.0168, 2)
    service.ingest(encodeFrame(5, [60, 120, NaN, NaN], 600), start + 4201)
    expect(service.snapshot(start + 4201).airspeedAtmosphere).toBeNull()
    expect(snapshotAirspeed(service.snapshot(start + 4201), 'press1')).toBeNull()
    await service.act({ type: 'daq-disconnect' })
    expect(service.snapshot(start + 2300).airspeedAtmosphere).toBeNull()
    await service.act(connect)
    expect(service.snapshot().airspeedAtmosphere).toBeNull()
  })
  it('persists versioned hardware calibration and transforms only future samples', async () => {
    await service.act(connect)
    transport.emit(encodeFrame(2, [100, 200, 300, 400], 100))
    await service.act({
      type: 'calibrate',
      channelId: 'strain2',
      unit: 'N',
      points: [
        { raw: 0, reference: 0 },
        { raw: 100, reference: 10 },
      ],
    })
    expect(service.snapshot().measurements.strain2?.value).toBe(200)
    transport.emit(encodeFrame(2, [100, 200, 300, 400], 200))
    expect(service.snapshot().measurements.strain2).toMatchObject({
      raw: 200,
      value: 20,
      unit: 'N',
      calibrationVersion: 1,
    })
    await service.act({ type: 'tare', channelId: 'strain2' })
    transport.emit(encodeFrame(2, [100, 200, 300, 400], 300))
    expect(service.snapshot().measurements.strain2?.value).toBe(0)
    expect(
      JSON.parse(await readFile(join(directory, 'hardware.json'), 'utf8')).strain2.version,
    ).toBe(2)
  })
  it('preserves raw evidence after a clock fault and recovers only on reconnect', async () => {
    await service.act(connect)
    const receivedBefore = service.snapshot().daq.receivedBytes
    transport.emit(encodeFrame(4, [101], 1000))
    transport.emit(encodeFrame(4, [999], 100))
    expect(service.snapshot().measurements.abs_pressure?.raw).toBe(101)
    expect(service.snapshot().acquisition).toBe('stopped')
    await expect(
      service.act({ type: 'acquisition', running: true, periodMs: 100 }),
    ).rejects.toThrow('clock fault')
    expect(service.snapshot().daq.receivedBytes).toBe(receivedBefore + 18)
    await service.act({ type: 'fan-output', percent: 0 })
    expect(service.snapshot().fan.confirmedMillivolts).toBe(0)
    await service.act(connect)
    expect(service.snapshot().measurements).toEqual({})
    transport.emit(encodeFrame(4, [102], 1))
    expect(service.snapshot().measurements.abs_pressure?.raw).toBe(102)
  })
  it('applies the bounded fan reference and verifies zero before disconnecting', async () => {
    await service.act(connect)
    await service.act({ type: 'fan-output', percent: 100 })
    expect(service.snapshot().fan).toMatchObject({ status: 'confirmed', confirmedMillivolts: 3000 })
    await service.act({ type: 'daq-disconnect' })
    expect(transport.writes.map((b) => b.toString('hex'))).toEqual([
      '210000',
      '01000186a0',
      '210bb8',
      '210000',
      '00',
    ])
    expect(service.snapshot().fan.status).toBe('unverified')
  })
  it('continues processing zero acknowledgments during normal application shutdown', async () => {
    await service.act(connect)
    await service.act({ type: 'fan-output', percent: 5 })
    await service.dispose()
    expect(transport.writes.slice(-2).map((b) => b.toString('hex'))).toEqual(['210000', '00'])
    expect(transport.closed).toBe(true)
  })
  it('cancels queued nonzero requests when a zero-output stop arrives', async () => {
    await service.act(connect)
    const before = transport.writes.length
    const request = service.act({ type: 'fan-output', percent: 80 })
    const rejected = expect(request).rejects.toThrow('superseded')
    await service.act({ type: 'fan-output', percent: 0 })
    await rejected
    expect(transport.writes.slice(before).map((b) => b.toString('hex'))).toEqual(['210000'])
  })
  it('never transfers a queued nonzero reference to a new connection', async () => {
    await service.act(connect)
    const reconnecting = service.act(connect)
    const request = service.act({ type: 'fan-output', percent: 90 })
    const rejected = expect(request).rejects.toThrow('connection changed')
    await reconnecting
    await rejected
    expect(
      transport.writes.filter((b) => b[0] === 0x21).every((b) => b.readUInt16BE(1) === 0),
    ).toBe(true)
    expect(service.snapshot().fan.confirmedMillivolts).toBe(0)
  })
  it('cancels an unsent nonzero request while waiting for firmware command pacing', async () => {
    const paced = new TunnelService(new SettingsStore(join(directory, 'paced.json')), {
      recorder: new Recorder(),
      transportFactory: () => transport,
      commandSpacingMs: 50,
      fanAckTimeoutMs: 100,
    })
    try {
      await paced.initialize()
      await paced.act(connect)
      const request = paced.act({ type: 'fan-output', percent: 80 })
      const rejected = expect(request).rejects.toThrow('superseded')
      await new Promise((resolve) => setTimeout(resolve, 5))
      await paced.act({ type: 'fan-output', percent: 0 })
      await rejected
      expect(
        transport.writes.filter((b) => b[0] === 0x21).every((b) => b.readUInt16BE(1) === 0),
      ).toBe(true)
      expect(paced.snapshot()).toMatchObject({
        emergencyStopped: false,
        fan: { confirmedMillivolts: 0 },
      })
    } finally {
      await paced.dispose()
    }
  })
  it('latches a fault and requests zero when a nonzero acknowledgment is missing', async () => {
    await service.act(connect)
    const original = transport.write.bind(transport)
    transport.write = async (data) => {
      transport.acknowledgeDac = !(
        data[0] === 0x21 &&
        new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(1) > 0
      )
      await original(data)
    }
    await expect(service.act({ type: 'fan-output', percent: 5 })).rejects.toThrow(
      'No board acknowledgment',
    )
    expect(service.snapshot()).toMatchObject({
      emergencyStopped: true,
      daq: { state: 'connected' },
      fan: { confirmedMillivolts: 0, status: 'confirmed' },
    })
    await expect(service.act({ type: 'fan-output', percent: 10 })).rejects.toThrow('Emergency Stop')
  })
  it('keeps acquisition and recording connected when startup DAC zero is not acknowledged', async () => {
    transport.acknowledgeDac = false
    await service.act(connect)
    expect(service.snapshot()).toMatchObject({
      daq: { state: 'connected' },
      acquisition: 'running',
      fan: { status: 'error' },
    })
    expect(transport.closed).toBe(false)
    await service.recorder.start(join(directory, 'daq-without-fan.jsonl'), {})
    transport.emit(encodeFrame(5, [-0.1, 2, NaN, NaN], 100))
    expect(service.snapshot().measurements.press1?.raw).toBeCloseTo(-0.1)
    expect(service.snapshot().recording.rows).toBe(4)
    await service.act({ type: 'acquisition', running: false, periodMs: 100 })
    await service.act({ type: 'acquisition', running: true, periodMs: 100 })
    expect(service.snapshot().daq.state).toBe('connected')
    await service.recorder.stop()
    transport.acknowledgeDac = true
    await service.act({ type: 'fan-output', percent: 0 })
    await service.act({ type: 'fan-output', percent: 5 })
    expect(service.snapshot().fan.confirmedMillivolts).toBe(150)
  })
  it('applies fan output directly without a VFD run-state gate and reconnects at zero', async () => {
    await service.act(connect)
    expect('vfdRunConfirmed' in service.snapshot()).toBe(false)
    await expect(service.act({ type: 'vfd-run-confirm', running: true })).rejects.toThrow()
    await service.act({ type: 'fan-output', percent: 5 })
    expect(service.snapshot().fan.confirmedMillivolts).toBe(150)
    await service.act({ type: 'fan-output', percent: 0 })
    expect(service.snapshot()).toMatchObject({
      acquisition: 'running',
      daq: { state: 'connected' },
      fan: { confirmedMillivolts: 0 },
    })
    transport.emit(encodeFrame(5, [0, 0, NaN, NaN], 200))
    expect(service.snapshot().measurements.press1?.raw).toBe(0)
    await service.act({ type: 'fan-output', percent: 5 })
    await service.act(connect)
    expect(service.snapshot().fan.confirmedMillivolts).toBe(0)
  })
  it('keeps the DAQ connected when a zero-output retry is not acknowledged', async () => {
    await service.act(connect)
    transport.acknowledgeDac = false
    await expect(service.act({ type: 'fan-output', percent: 0 })).rejects.toThrow(
      'No board acknowledgment',
    )
    expect(service.snapshot()).toMatchObject({
      daq: { state: 'connected' },
      acquisition: 'running',
    })
    transport.emit(encodeFrame(4, [99], 100))
    expect(service.snapshot().measurements.abs_pressure?.value).toBe(99)
  })
  it('stops recording and invalidates readings on USB loss without a synthetic fallback', async () => {
    await service.act(connect)
    await service.recorder.start(join(directory, 'lost.jsonl'), {})
    transport.emit(encodeFrame(4, [101], 100))
    transport.events!.close()
    expect(service.snapshot()).toMatchObject({
      acquisition: 'stopped',
      daq: { state: 'error' },
      measurements: { abs_pressure: { quality: 'stale' } },
    })
    await service.recorder.stop()
    expect(service.snapshot().recording.active).toBe(false)
    await expect(
      service.act({ type: 'acquisition', running: true, periodMs: 100 }),
    ).rejects.toThrow('Connect a DAQ')
  })
})
