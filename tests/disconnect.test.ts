import { afterEach, describe, expect, it } from 'vitest'
import { TunnelService } from '../src/main/tunnel-service'
import { Recorder } from '../src/infrastructure/recording'
import { MemoryRecordingStorage } from './support/memory-storage'
import { FakeTransport, connect } from './helpers'
import { encodeFrame } from '../src/domain/protocol'

describe('explicit Disconnect', () => {
  let service: TunnelService
  let transport: FakeTransport
  function setup() {
    transport = new FakeTransport()
    const storage = new MemoryRecordingStorage()
    const recorder = new Recorder(storage)
    service = new TunnelService(
      { load: async () => ({}), save: async () => {} },
      {
        recorder,
        transportFactory: () => transport,
        commandSpacingMs: 0,
        fanAckTimeoutMs: 20,
      },
    )
    return { storage, recorder }
  }
  afterEach(async () => {
    if (transport) transport.acknowledgeDac = true
    await service?.dispose().catch(() => {})
  })
  it('acknowledges zero before releasing the DAQ and finalizes every accepted sample', async () => {
    const { storage, recorder } = setup()
    await service.initialize()
    await service.act(connect)
    await recorder.start('run.jsonl', {})
    transport.emit(encodeFrame(5, [0, 1, NaN, -2], 100))
    await service.act({ type: 'fan-output', percent: 5 })
    const first = service.disconnectAll()
    expect(service.snapshot().disconnecting).toBe(true)
    expect(service.disconnectAll()).toBe(first)
    await first
    expect(transport.writes.slice(-2).map((b) => b.toString('hex'))).toEqual(['210000', '00'])
    expect(transport.closed).toBe(true)
    expect(service.snapshot()).toMatchObject({
      disconnecting: false,
      acquisition: 'stopped',
      daq: { state: 'disconnected' },
      measurements: { press1: { quality: 'stale' } },
      recording: { active: false, rows: 4 },
    })
    expect((await storage.list())[0]).toMatchObject({ status: 'complete', rows: 4 })
  })
  it('supersedes queued output and rejects new commands while disconnecting', async () => {
    setup()
    await service.act(connect)
    const pending = service.act({ type: 'fan-output', percent: 80 })
    const rejected = expect(pending).rejects.toThrow(/Disconnect|superseded/)
    const disconnecting = service.disconnectAll()
    await expect(service.actPitot({ type: 'connect' })).rejects.toThrow('Disconnect')
    await rejected
    await disconnecting
    expect(
      transport.writes.filter((b) => b[0] === 0x21).every((b) => b.readUInt16BE(1) === 0),
    ).toBe(true)
  })
  it('finalizes recording but retains a healthy DAQ for retry if zero is unacknowledged', async () => {
    const { storage, recorder } = setup()
    await service.act(connect)
    await recorder.start('retry.jsonl', {})
    transport.acknowledgeDac = false
    await expect(service.disconnectAll()).rejects.toThrow('kept connected')
    expect(service.snapshot()).toMatchObject({
      daq: { state: 'connected' },
      recording: { active: false },
    })
    expect(transport.closed).toBe(false)
    expect((await storage.list())[0]?.status).toBe('complete')
    transport.acknowledgeDac = true
    await service.disconnectAll()
    expect(transport.closed).toBe(true)
  })
  it('reports finalization failures even when USB shutdown succeeds', async () => {
    const { storage, recorder } = setup()
    await service.act(connect)
    await recorder.start('failed-close.jsonl', {})
    storage.failFinalization = true
    await expect(service.disconnectAll()).rejects.toThrow('Finalization failed')
    expect(transport.closed).toBe(true)
    expect(service.snapshot().recording.error).toContain('retry Disconnect')
    storage.failFinalization = false
    await service.disconnectAll()
    expect((await storage.list())[0]?.status).toBe('complete')
    expect(service.snapshot().recording.error).toBeNull()
  })
  it('still verifies zero when Emergency Stop is already latched', async () => {
    setup()
    await service.act(connect)
    await service.act({ type: 'emergency-stop' })
    const before = transport.writes.length
    await service.disconnectAll()
    expect(transport.writes.slice(before).map((b) => b.toString('hex'))).toEqual(['210000'])
  })
})
